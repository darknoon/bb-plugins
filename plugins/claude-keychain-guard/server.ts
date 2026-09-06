import type { BbPluginApi, ExperimentalPluginProviderEnvContext, ExperimentalPluginProviderEnvEntry } from '@get-bb/plugin-sdk';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const HOST = 'host_5e5sg5gdn4';
const WRAPPER = '/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard/claude-guarded';
export function contributions(context: ExperimentalPluginProviderEnvContext, allThreads: boolean, canaryThread: string): ExperimentalPluginProviderEnvEntry[] {
  if (context.hostId !== HOST || (!allThreads && context.threadId !== canaryThread)) return [];
  return [{name:'BB_CLAUDE_CODE_EXECUTABLE',value:WRAPPER,reason:'Classify denied Claude Keychain reads as errors; preserve other auth behavior',secret:false}];
}
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    allThreads: {type:'boolean',label:'Guard new Claude processes on mini',default:false},
    canaryThread: {type:'string',label:'Canary thread while guard is not enabled globally',default:'thr_bn2xraubgc'},
  });
  bb.providers.experimental_contributeEnv('claude-code',async context => {
    const values = await settings.get();
    const entries = contributions(context,values.allThreads,values.canaryThread);
    if (entries.length) await access(WRAPPER,constants.X_OK);
    return entries;
  });
}
