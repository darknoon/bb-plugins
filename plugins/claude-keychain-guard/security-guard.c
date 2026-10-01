// Security delegate; the write filter inspects credentials only in memory.
#include <unistd.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <libproc.h>
#include "guard-policy.h"
#ifndef BB_SECURITY_EXECUTABLE
#define BB_SECURITY_EXECUTABLE "/usr/bin/security"
#endif
#ifndef BB_AUTH_LOG_DIRECTORY
#define BB_AUTH_LOG_DIRECTORY "/Users/andrew/.local/state/bb-claude-auth"
#endif
#ifndef BB_READ_SELECTOR
#define BB_READ_SELECTOR "/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/read-selector.cjs"
#endif
#ifndef BB_ENABLE_READ_SELECTOR
#define BB_ENABLE_READ_SELECTOR 0
#endif
#ifndef BB_WRITE_GUARD
#define BB_WRITE_GUARD "/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/write-guard.cjs"
#endif
#ifndef BB_ENABLE_WRITE_GUARD
#define BB_ENABLE_WRITE_GUARD 0
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
static void forward_signal(int sig) { if (child > 0) { kill(-child, sig); kill(child, sig); } }
static int read_cooldown(int mark) {
    int flags=mark ? O_WRONLY|O_CREAT|O_TRUNC : O_RDONLY;
    int fd=open(BB_AUTH_LOG_DIRECTORY "/read-cooldown",flags|O_NOFOLLOW|O_NONBLOCK,0600);
    if(fd<0)return 0;
    struct stat st;
    if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&077)){close(fd);return 0;}
    long long until=0;
    if(mark){until=millis(CLOCK_REALTIME)+30000;dprintf(fd,"%lld",until);}
    else {char buf[32]={0};if(read(fd,buf,sizeof(buf)-1)>0)until=atoll(buf);}
    close(fd);return until>millis(CLOCK_REALTIME) && until<=millis(CLOCK_REALTIME)+31000;
}
int main(int argc, char **argv) {
    const char *op = operation(argc, argv);
    const long long start = millis(CLOCK_MONOTONIC);
    char caller[PROC_PIDPATHINFO_MAXSIZE]={0};
#ifdef BB_TEST_CALLER_PATH
    snprintf(caller,sizeof(caller),"%s",BB_TEST_CALLER_PATH);
#else
    proc_pidpath(getppid(),caller,sizeof(caller));
#endif
    const char *version=verified_caller(caller);
    int filtered=BB_ENABLE_WRITE_GUARD && version && op && (!strcmp(op,"write") || (!strcmp(op,"interactive-write") && !isatty(0)));
    int bounded=op && (strcmp(op,"interactive-write") || filtered);
    if(BB_ENABLE_WRITE_GUARD && !version && op)trace(op,"unverified-caller",-1,-1,-1,0);
    if(op && !strcmp(op,"read") && read_cooldown(0)){
        trace(op,"backoff",-1,-1,1,0);return 1;
    }
    signal(SIGTERM, forward_signal); signal(SIGINT, forward_signal); signal(SIGHUP, forward_signal);
    child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        setsid(); // bounded termination includes the delegate's children
        const char *select = getenv("BB_CLAUDE_AUTH_READ_SELECTION");
        int secret_read=0;
        for(int i=2;i<argc;i++)if(!strcmp(argv[i],"-w"))secret_read=1;
        if(filtered)setenv("BB_VERIFIED_CLAUDE_CALLER",version,1);
        else unsetenv("BB_VERIFIED_CLAUDE_CALLER");
        argv[0] = filtered ? BB_WRITE_GUARD :
            BB_ENABLE_READ_SELECTOR && select && !strcmp(select,"verified") && guarded_read(argc,argv) && secret_read ? BB_READ_SELECTOR : BB_SECURITY_EXECUTABLE;
        execv(argv[0], argv);
        _exit(127);
    }
    trace(op,"start",child,-1,-1,0);
    int status=0;
    const long long limit=op && !strcmp(op,"read") ? 1500 : 6000;
    while (1) {
        pid_t done=waitpid(child,&status,bounded ? WNOHANG : 0);
        if(done==child)break;
        if(done<0 && errno!=EINTR)return 1;
        if(bounded && millis(CLOCK_MONOTONIC)-start>=limit){
            kill(-child,SIGKILL);kill(child,SIGKILL);
            while(waitpid(child,&status,0)<0 && errno==EINTR){}
            trace(op,"timeout",child,124,1,millis(CLOCK_MONOTONIC)-start);
            if(!strcmp(op,"read"))read_cooldown(1);
            return 1;
        }
        struct timespec delay={0,1000000};nanosleep(&delay,NULL);
    }
    int original = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    int result = guarded_exit(argc, argv, original);
    if(op && !strcmp(op,"read") && (original==36 || original==143))read_cooldown(1);
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
