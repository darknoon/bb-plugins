import type { BbPluginApi, ExperimentalPluginProviderEnvContext, ExperimentalPluginProviderEnvEntry } from '@get-bb/plugin-sdk';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const HOST = 'host_5e5sg5gdn4';
const WRAPPER = '/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/claude-guarded';
export function contributions(context: ExperimentalPluginProviderEnvContext, allThreads: boolean, canaryThread: string, readSelection=false): ExperimentalPluginProviderEnvEntry[] {
  if (context.hostId !== HOST || (!allThreads && context.threadId !== canaryThread)) return [];
  return [{name:'BB_CLAUDE_CODE_EXECUTABLE',value:WRAPPER,reason:'Classify denied Claude Keychain reads as errors; preserve other auth behavior'},
    ...(readSelection ? [{name:'BB_CLAUDE_AUTH_READ_SELECTION',value:'verified',reason:'Read newer file OAuth only after account identity verification'}] : [])];
}
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    allThreads: {type:'boolean',label:'Guard new Claude processes on mini',default:false},
    canaryThread: {type:'string',label:'Canary thread while guard is not enabled globally',default:'thr_bn2xraubgc'},
    readSelectionCanary: {type:'boolean',label:'Verify credential read selection on canary only',default:false},
    readSelectionAll: {type:'boolean',label:'Use identity-verified credential read selection on all mini threads',default:false},
  });
  bb.providers.experimental_contributeEnv('claude-code',async context => {
    const values = await settings.get();
    const selected=values.readSelectionAll || (values.readSelectionCanary && context.threadId===values.canaryThread);
    const entries = contributions(context,values.allThreads,values.canaryThread,selected);
    if (entries.length) await access(WRAPPER,constants.X_OK);
    return entries;
  });
}
