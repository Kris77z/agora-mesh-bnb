import type {AgentEvent,HunterRunResult} from '@/types/agent';
export type BoundedRunViewInput={status:string;events:AgentEvent[];result?:HunterRunResult;recoveryRequired?:boolean;recovery?:{status:string;message:string};error?:{message:string}};
export function boundedRunView(run?:BoundedRunViewInput){
 const recovering=run?.recovery?.status==='running';
 const blocked=Boolean(run?.recoveryRequired&&!recovering);
 const status=!run?'IDLE':recovering?'RUNNING':blocked?'ERROR':run.status==='completed'?'COMPLETED':run.status==='running'?'RUNNING':'ERROR';
 return {status,events:run?.events??[],result:run?.result??null,error:blocked?'Execution was interrupted. Check the original task before starting another.':run?.error?.message??null} as {status:'IDLE'|'RUNNING'|'COMPLETED'|'ERROR';events:AgentEvent[];result:HunterRunResult|null;error:string|null};
}
