#include <assert.h>
#include <stdio.h>
#include "guard-policy.h"
int main(int argc, char **argv) {
    if (argc > 1) return guarded_exit(argc-1,argv+1,36);
    char *read[] = {"security","find-generic-password","-a","andrew","-w","-s","Claude Code-credentials"};
    assert(guarded_exit(7,read,36)==1);
    assert(guarded_exit(7,read,0)==0);
    assert(guarded_exit(7,read,44)==44);
    assert(guarded_exit(7,read,1)==1);
    char *other[] = {"security","find-generic-password","-a","andrew","-s","unrelated"};
    assert(guarded_exit(6,other,36)==36);
    char *account[] = {"security","find-generic-password","-a","someone-else","-s","Claude Code-credentials"};
    assert(guarded_exit(6,account,36)==36);
    char *write[] = {"security","add-generic-password","-a","andrew","-s","Claude Code-credentials"};
    assert(guarded_exit(6,write,36)==36);
    char *remove[] = {"security","delete-generic-password","-a","andrew","-s","Claude Code-credentials"};
    assert(guarded_exit(6,remove,36)==36);
    char *info[] = {"security","show-keychain-info"};
    assert(guarded_exit(2,info,36)==36);
    puts("9 policy checks passed; write/delete behavior unchanged");
}
