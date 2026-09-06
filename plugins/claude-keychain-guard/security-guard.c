// Transparent security command delegate; never parses or saves credential data.
#include <unistd.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>
#include <sys/stat.h>
#include "guard-policy.h"
#ifndef BB_SECURITY_EXECUTABLE
#define BB_SECURITY_EXECUTABLE "/usr/bin/security"
#endif
#ifndef BB_AUTH_LOG_DIRECTORY
#define BB_AUTH_LOG_DIRECTORY "/Users/andrew/.local/state/bb-claude-auth"
#endif
static long long millis(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t)) return 0;
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static const char *operation(int argc, char **argv) {
    if (guarded_read(argc, argv)) return "read";
    if (argc == 2 && !strcmp(argv[1], "-i")) return "interactive-write";
    if (argc < 2) return NULL;
    if (strcmp(argv[1], "add-generic-password") && strcmp(argv[1], "delete-generic-password")) return NULL;
    int account = 0, service = 0;
    for (int i = 2; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "-a") && !strcmp(argv[i+1], "andrew")) account = 1;
        if (!strcmp(argv[i], "-s") && !strcmp(argv[i+1], "Claude Code-credentials")) service = 1;
    }
    return account && service ? (!strcmp(argv[1], "add-generic-password") ? "write" : "delete") : NULL;
}
static int log_fd(const char *path) {
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600);
    struct stat st;
    if (fd >= 0 && (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077) || st.st_size > 20*1024*1024)) {
        close(fd); return -1;
    }
    return fd;
}
static void trace(const char *op, const char *phase, int child_pid, int original, int returned, long long elapsed) {
    if (!op) return;
    int fd = log_fd(BB_AUTH_LOG_DIRECTORY "/security-operations.jsonl");
    if (fd < 0) return;
    // All strings are fixed literals: never argv, stdin, stdout, stderr, or env.
    dprintf(fd,"{\"atMs\":%lld,\"pid\":%d,\"parentPid\":%d,\"childPid\":%d,\"operation\":\"%s\",\"phase\":\"%s\",\"originalExit\":%d,\"returnedExit\":%d,\"elapsedMs\":%lld}\n",
        millis(CLOCK_REALTIME),getpid(),getppid(),child_pid,op,phase,original,returned,elapsed);
    close(fd);
}
static volatile sig_atomic_t child = -1;
static void forward_signal(int sig) { if (child > 0) kill(child, sig); }
int main(int argc, char **argv) {
    const char *op = operation(argc, argv);
    const long long start = millis(CLOCK_MONOTONIC);
    signal(SIGTERM, forward_signal); signal(SIGINT, forward_signal); signal(SIGHUP, forward_signal);
    child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        argv[0] = BB_SECURITY_EXECUTABLE;
        execv(argv[0], argv);
        _exit(127);
    }
    trace(op,"start",child,-1,-1,0);
    int status;
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) return 1; }
    int original = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    int result = guarded_exit(argc, argv, original);
    trace(op,"finish",child,original,result,millis(CLOCK_MONOTONIC)-start);
    if (result != original) {
        int fd = log_fd(BB_AUTH_LOG_DIRECTORY "/guard.jsonl");
        if (fd >= 0) {
            dprintf(fd,"{\"at\":%lld,\"parentPid\":%d,\"event\":\"denied-read-classified-as-error\",\"originalExit\":36,\"returnedExit\":1}\n",(long long)time(NULL),getppid());
            close(fd);
        }
    }
    return result;
}
