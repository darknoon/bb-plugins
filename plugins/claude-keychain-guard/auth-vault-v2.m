// Encrypted snapshots in a separate Keychain item; never prints credentials.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
#include <poll.h>
#include <signal.h>
#include <errno.h>
#include <time.h>
#ifndef BB_PRIMARY_SECURITY
#define BB_PRIMARY_SECURITY "/usr/bin/security"
#endif

// The native helper is not authorized by Claude's existing item ACL; security is.
// Keep that ACL unchanged, credentials off argv/logs, and bound the child lifetime.
static NSData *readPrimary(int *result) {
    *result=74;
    int pipes[2];if(pipe(pipes))return nil;
    posix_spawn_file_actions_t actions;posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_addopen(&actions,STDIN_FILENO,"/dev/null",O_RDONLY,0);
    posix_spawn_file_actions_addopen(&actions,STDERR_FILENO,"/dev/null",O_WRONLY,0);
    posix_spawn_file_actions_adddup2(&actions,pipes[1],STDOUT_FILENO);
    posix_spawn_file_actions_addclose(&actions,pipes[0]);
    posix_spawn_file_actions_addclose(&actions,pipes[1]);
    char *args[]={BB_PRIMARY_SECURITY,"find-generic-password","-a","andrew","-s","Claude Code-credentials","-w","/Users/andrew/Library/Keychains/login.keychain-db",NULL};
    char *env[]={"PATH=/usr/bin:/bin",NULL};
    pid_t child;int launched=posix_spawn(&child,args[0],&actions,NULL,args,env);
    posix_spawn_file_actions_destroy(&actions);close(pipes[1]);
    if(launched){close(pipes[0]);return nil;}
    fcntl(pipes[0],F_SETFL,O_NONBLOCK);
    NSMutableData *data=[NSMutableData data];
    uint64_t deadline=clock_gettime_nsec_np(CLOCK_MONOTONIC)+200000000;
    BOOL done=NO,failed=NO;int status=0;
    while(!done && !failed){
        char bytes[4096];ssize_t n;
        while((n=read(pipes[0],bytes,sizeof(bytes)))>0){
            if(data.length+(NSUInteger)n>1024*1024){failed=YES;break;}
            [data appendBytes:bytes length:(NSUInteger)n];
        }
        if(n<0 && errno!=EAGAIN && errno!=EINTR)failed=YES;
        pid_t waited=waitpid(child,&status,WNOHANG);
        if(waited==child){done=YES;continue;}
        if(waited<0 && errno!=EINTR){failed=YES;break;}
        if(clock_gettime_nsec_np(CLOCK_MONOTONIC)>=deadline){failed=YES;break;}
        struct pollfd p={pipes[0],POLLIN,0};poll(&p,1,5);
    }
    if(!done){kill(child,SIGKILL);while(waitpid(child,&status,0)<0 && errno==EINTR){}}
    // Drain bytes already buffered when waitpid observed the child's exit.
    if(done && !failed){char bytes[4096];ssize_t n;while((n=read(pipes[0],bytes,sizeof(bytes)))>0){
        if(data.length+(NSUInteger)n>1024*1024){failed=YES;break;}[data appendBytes:bytes length:(NSUInteger)n];}}
    close(pipes[0]);
    if(failed || !WIFEXITED(status))return nil;
    int code=WEXITSTATUS(status);
    if(code==44){*result=0;return nil;} // Missing item is not an unreadable item.
    if(code!=0)return nil;
    *result=0;return data;
}

static NSString *const Service = @"bb-Claude-auth-recovery-v2";
static NSString *const Account = @"andrew";
static NSMutableDictionary *query(NSString *service) {
    return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
              (__bridge id)kSecAttrService:service, (__bridge id)kSecAttrAccount:Account} mutableCopy];
}
static NSData *readItem(NSString *service, OSStatus *status) {
    NSMutableDictionary *q=query(service);
    q[(__bridge id)kSecReturnData]=@YES;
    q[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
    CFTypeRef result=NULL;
    *status=SecItemCopyMatching((__bridge CFDictionaryRef)q,&result);
    return *status==errSecSuccess ? CFBridgingRelease(result) : nil;
}
static OSStatus writeItem(NSString *service, NSData *data) {
    NSMutableDictionary *q=query(service);
    NSDictionary *attrs=@{(__bridge id)kSecValueData:data};
    OSStatus status=SecItemUpdate((__bridge CFDictionaryRef)q,(__bridge CFDictionaryRef)attrs);
    if(status==errSecItemNotFound){q[(__bridge id)kSecValueData]=data;q[(__bridge id)kSecAttrLabel]=service;status=SecItemAdd((__bridge CFDictionaryRef)q,NULL);}
    return status;
}
static NSDictionary *object(NSData *data) {
    if(!data || data.length>1024*1024)return nil;
    id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:NSDictionary.class]?value:nil;
}
static BOOL complete(NSDictionary *record) {
    id o=record[@"claudeAiOauth"];
    return [o isKindOfClass:NSDictionary.class] && [o[@"accessToken"] isKindOfClass:NSString.class]
      && [o[@"accessToken"] length]>0 && [o[@"refreshToken"] isKindOfClass:NSString.class]
      && [o[@"refreshToken"] length]>0 && [o[@"expiresAt"] isKindOfClass:NSNumber.class];
}
static BOOL addSnapshot(NSMutableArray *snapshots, NSDictionary *record, NSString *source, NSDictionary *identity) {
    if(!complete(record))return NO;
    NSDictionary *oauth=record[@"claudeAiOauth"];
    for(NSDictionary *entry in snapshots){
        NSDictionary *old=entry[@"record"][@"claudeAiOauth"];
        if([entry[@"source"] isEqual:source] && [old isEqual:oauth]
           && [entry[@"record"] isEqual:record] && [entry[@"identity"] isEqual:identity])return NO;
    }
    [snapshots addObject:@{@"source":source,@"capturedAt":@((long long)(NSDate.date.timeIntervalSince1970*1000)),
                          @"identity":identity,@"record":record}];
    // Independent rings: a frequently changing file cannot evict Keychain history.
    NSUInteger count=0;
    for(NSDictionary *entry in snapshots)if([entry[@"source"] isEqual:source])count++;
    while(count>8){
        NSUInteger i=[snapshots indexOfObjectPassingTest:^BOOL(id entry, NSUInteger idx, BOOL *stop){
            (void)idx;(void)stop;return [entry[@"source"] isEqual:source];
        }];
        [snapshots removeObjectAtIndex:i];count--;
    }
    return YES;
}
static int selftest(void) {
    NSMutableArray *a=[NSMutableArray array];
    NSDictionary *identity=@{@"accountUuid":@"dummy"};
    NSDictionary *good=@{@"claudeAiOauth":@{@"accessToken":@"dummy-a",@"refreshToken":@"dummy-r",@"expiresAt":@1},
                          @"mcpOAuth":@{@"connector":@"dummy-connector"}};
    if(!addSnapshot(a,good,@"keychain",identity))return 1;
    if(addSnapshot(a,good,@"keychain",identity))return 2;
    if(addSnapshot(a,@{@"claudeAiOauth":@{@"accessToken":@"",@"refreshToken":@"",@"expiresAt":@0}},@"keychain",identity))return 3;
    if(a.count!=1 || ![a[0][@"record"] isEqual:good])return 4;
    for(int n=0;n<20;n++){
        NSDictionary *record=@{@"claudeAiOauth":@{@"accessToken":[NSString stringWithFormat:@"dummy-%d",n],@"refreshToken":@"dummy-r",@"expiresAt":@(n)}};
        addSnapshot(a,record,@"file",identity);
    }
    if(a.count!=9 || ![a[0][@"source"] isEqual:@"keychain"])return 5;
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"snapshots":a} options:0 error:nil];
    if(![object(data)[@"snapshots"][0][@"record"] isEqual:good])return 6;
    puts("PASS: deduplication, empty-write preservation, expired-token retention, per-store rotation, connector retention, serialization");
    return 0;
}
static int keychainTest(void) {
    NSString *service=[@"bb-Claude-auth-recovery-test-" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSString *backupService=[service stringByAppendingString:@"-backup"];
    NSDictionary *record=@{@"claudeAiOauth":@{@"accessToken":@"dummy-a",@"refreshToken":@"dummy-r",@"expiresAt":@1},@"mcpOAuth":@{@"dummy":@"retained"}};
    NSData *dummy=[NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
    OSStatus written=writeItem(service,dummy),status;
    if(written!=errSecSuccess)return 74;
    int result=74;
    @try {
        NSMutableArray *history=[NSMutableArray array];
        addSnapshot(history,object(readItem(service,&status)),@"keychain",@{});
        NSData *archive=[NSJSONSerialization dataWithJSONObject:@{@"version":@1,@"snapshots":history} options:0 error:nil];
        if(status!=errSecSuccess || writeItem(backupService,archive)!=errSecSuccess)return result;
        // Simulate the exact empty-token failure, on a dummy item only.
        NSData *empty=[NSJSONSerialization dataWithJSONObject:@{@"claudeAiOauth":@{@"accessToken":@"",@"refreshToken":@"",@"expiresAt":@0}} options:0 error:nil];
        if(writeItem(service,empty)!=errSecSuccess)return result;
        NSDictionary *saved=object(readItem(backupService,&status));
        NSDictionary *recovered=saved[@"snapshots"][0][@"record"];
        if(status!=errSecSuccess || ![recovered isEqual:record])return result;
        NSData *restored=[NSJSONSerialization dataWithJSONObject:recovered options:0 error:nil];
        if(writeItem(service,restored)!=errSecSuccess)return result;
        NSDictionary *readback=object(readItem(service,&status));
        if(status!=errSecSuccess || ![readback isEqual:record])return result;
        result=0;
    } @finally {
        OSStatus a=SecItemDelete((__bridge CFDictionaryRef)query(service));
        OSStatus b=SecItemDelete((__bridge CFDictionaryRef)query(backupService));
        if(a!=errSecSuccess || (b!=errSecSuccess && b!=errSecItemNotFound))result=74;
    }
    if(result==0)puts("PASS: encrypted snapshot -> dummy primary wipe -> restore tokens and connector fields; both dummy items removed");
    return result;
}
int main(int argc,const char **argv){@autoreleasepool{
    if(argc!=2)return 64;
    NSString *command=@(argv[1]);
    if([command isEqual:@"selftest"])return selftest();
    // Never put a consent prompt on the desktop or alter global Keychain settings.
    SecKeychainSetUserInteractionAllowed(false);
    if([command isEqual:@"initialize"]){
        OSStatus initialStatus;
        NSData *existing=readItem(Service,&initialStatus);
        if(initialStatus==errSecSuccess)return object(existing)?0:65;
        if(initialStatus!=errSecItemNotFound)return 74;
        NSData *empty=[NSJSONSerialization dataWithJSONObject:@{@"version":@1,@"snapshots":@[]} options:0 error:nil];
        NSMutableDictionary *q=query(Service);
        q[(__bridge id)kSecValueData]=empty;
        q[(__bridge id)kSecAttrLabel]=Service;
        if(SecItemAdd((__bridge CFDictionaryRef)q,NULL)!=errSecSuccess)return 74;
        NSData *verified=readItem(Service,&initialStatus);
        if(initialStatus!=errSecSuccess || ![verified isEqual:empty])return 74;
        puts("Created labeled v2 backup item; no credentials captured yet.");
        return 0;
    }
    if([command isEqual:@"authorize-backup"]){
        // Explicit human-approved command only; background checkpoints never prompt.
        // The OS decides whether to allow this executable to read our backup item.
        SecKeychainSetUserInteractionAllowed(true);
        OSStatus permissionStatus;
        NSData *data=readItem(Service,&permissionStatus);
        if(permissionStatus!=errSecSuccess || !object(data))return 74;
        puts("Backup item access authorized; no credential values printed or changed.");
        return 0;
    }
    if([command isEqual:@"selftest-keychain"])return keychainTest();
    if(![command isEqual:@"checkpoint"] && ![command isEqual:@"status"])return 64;
    NSString *directory=@"/Users/andrew/.local/state/bb-claude-auth";
    struct stat st;
    if(lstat(directory.fileSystemRepresentation,&st)||!S_ISDIR(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&077))return 73;
    NSString *lockPath=[directory stringByAppendingPathComponent:@"vault.lock"];
    int fd=open(lockPath.fileSystemRepresentation,O_CREAT|O_RDWR|O_NOFOLLOW|O_NONBLOCK,0600);
    if(fd<0)return 73;
    if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||(st.st_mode&077)){close(fd);return 73;}
    if(flock(fd,LOCK_EX|LOCK_NB)){close(fd);return 75;}
    OSStatus status;
    NSData *stored=readItem(Service,&status);
    if(status!=errSecSuccess && status!=errSecItemNotFound){close(fd);return 74;}
    NSDictionary *vault=stored?object(stored):@{@"version":@1,@"snapshots":@[]};
    if(![vault[@"version"] isEqual:@1] || ![vault[@"snapshots"] isKindOfClass:NSArray.class]){close(fd);return 65;}
    for(id entry in vault[@"snapshots"]){
        if(![entry isKindOfClass:NSDictionary.class] || ![entry[@"record"] isKindOfClass:NSDictionary.class]
          || !complete(entry[@"record"]) || ![entry[@"source"] isKindOfClass:NSString.class]
          || ![entry[@"capturedAt"] isKindOfClass:NSNumber.class] || ![entry[@"identity"] isKindOfClass:NSDictionary.class]){close(fd);return 65;}
    }
    NSMutableArray *snapshots=[vault[@"snapshots"] mutableCopy];
    BOOL changed=NO;
    int primaryResult=0;
    if([command isEqual:@"checkpoint"]){
        NSDictionary *config=object([NSData dataWithContentsOfFile:@"/Users/andrew/.claude.json"]);
        NSDictionary *account=[config[@"oauthAccount"] isKindOfClass:NSDictionary.class]?config[@"oauthAccount"]:@{};
        NSMutableDictionary *identity=[NSMutableDictionary dictionary];
        for(NSString *k in @[@"accountUuid",@"organizationUuid"])if([account[k] isKindOfClass:NSString.class])identity[k]=account[k];
        NSData *primary=readPrimary(&primaryResult);
        if(primary && !object(primary))primaryResult=74;
        changed|=addSnapshot(snapshots,object(primary),@"keychain",identity);
        NSString *file=@"/Users/andrew/.claude/.credentials.json";
        int source=open(file.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);
        if(source>=0){
            if(!fstat(source,&st)&&S_ISREG(st.st_mode)&&st.st_uid==getuid()&&!(st.st_mode&077)&&st.st_size<=1024*1024){
                NSFileHandle *handle=[[NSFileHandle alloc]initWithFileDescriptor:source closeOnDealloc:NO];
                changed|=addSnapshot(snapshots,object([handle readDataToEndOfFile]),@"file",identity);
            }close(source);
        }
        if(changed){
            NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"version":@1,@"snapshots":snapshots} options:0 error:nil];
            if(!data || writeItem(Service,data)!=errSecSuccess){close(fd);return 74;}
            NSData *readback=readItem(Service,&status);
            if(status!=errSecSuccess || ![readback isEqual:data]){close(fd);return 74;}
        }
    }else{
        NSMutableArray *metadata=[NSMutableArray array];
        for(NSDictionary *entry in snapshots)[metadata addObject:@{@"source":entry[@"source"],@"capturedAt":entry[@"capturedAt"],
          @"expiresAt":entry[@"record"][@"claudeAiOauth"][@"expiresAt"]}];
        NSData *out=[NSJSONSerialization dataWithJSONObject:@{@"snapshots":metadata} options:0 error:nil];
        fwrite(out.bytes,1,out.length,stdout);puts("");
    }
    // Do not report protection when the initial snapshot has no credentials.
    if(primaryResult){close(fd);return primaryResult;}
    if([command isEqual:@"checkpoint"] && snapshots.count==0){close(fd);return 78;}
    close(fd);return 0;
}}

