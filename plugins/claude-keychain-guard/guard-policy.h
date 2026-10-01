#include <string.h>
static inline const char *verified_caller(const char *path) {
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.261")) return "2.1.261";
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.270")) return "2.1.270";
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.273")) return "2.1.273";
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.274")) return "2.1.274";
    if (!strcmp(path,"/Users/andrew/.local/share/claude/versions/2.1.285")) return "2.1.285";
    return NULL;
}
static int guarded_read(int argc, char **argv) {
    if (argc < 2 || strcmp(argv[1], "find-generic-password")) return 0;
    int account = 0, service = 0, paths = 0;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "-w") || !strcmp(argv[i], "-g")) continue;
        if (!strcmp(argv[i], "-a")) {
            if(account || ++i == argc || strcmp(argv[i], "andrew")) return 0;
            account = 1;
        } else if (!strcmp(argv[i], "-s")) {
            if(service || ++i == argc || strcmp(argv[i], "Claude Code-credentials")) return 0;
            service = 1;
        } else if (++paths > 1 || strcmp(argv[i], "/Users/andrew/Library/Keychains/login.keychain-db")) return 0;
    }
    return account && service;
}
static int guarded_exit(int argc, char **argv, int code) {
    // 36 is interaction-not-allowed; 1 reaches Claude's READ_FAILED path.
    // Success, missing-item 44, other items, and ALL writes stay untouched.
    return code == 36 && guarded_read(argc, argv) ? 1 : code;
}
