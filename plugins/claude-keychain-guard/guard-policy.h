#include <string.h>
static inline const char *verified_caller(const char *path) {
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.261")) return "2.1.261";
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.270")) return "2.1.270";
    return NULL;
}
static int guarded_read(int argc, char **argv) {
    if (argc < 2 || strcmp(argv[1], "find-generic-password")) return 0;
    int account = 0, service = 0;
    for (int i = 2; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "-a") && !strcmp(argv[i+1], "andrew")) account = 1;
        if (!strcmp(argv[i], "-s") && !strcmp(argv[i+1], "Claude Code-credentials")) service = 1;
    }
    return account && service;
}
static int guarded_exit(int argc, char **argv, int code) {
    // 36 is interaction-not-allowed; 1 reaches Claude's READ_FAILED path.
    // Success, missing-item 44, other items, and ALL writes stay untouched.
    return code == 36 && guarded_read(argc, argv) ? 1 : code;
}
