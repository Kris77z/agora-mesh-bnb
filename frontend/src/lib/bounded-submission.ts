import type {LanguageCode,RunRequestMode} from '@/types/agent';
export type AuthorityAccess={id:string;token:string;missionId?:string;requestKey?:string;requestGoal?:string;requestMode?:RunRequestMode;requestLocale?:LanguageCode};
export function prepareBoundedSubmission(access:AuthorityAccess,goal:string,mode:RunRequestMode,locale:LanguageCode,newId:()=>string){
 const requestGoal=goal.trim();
 if(!requestGoal) throw new Error('Enter a task goal.');
 const uncertain=Boolean(access.requestKey&&!access.missionId);
 if(uncertain&&(access.requestGoal!==requestGoal||(access.requestMode??'single')!==mode||(access.requestLocale??'en-US')!==locale)) throw new Error('The previous submission has an unknown outcome. Retry its original goal and mode to retrieve the same task.');
 return {...access,missionId:undefined,requestKey:uncertain?access.requestKey:newId(),requestGoal,requestMode:mode,requestLocale:locale};
}
export function isAuthorityReady(snapshot:{authority:{status:string;expiry:number;walletAddress:string};lifecycle?:{operation:string;pendingStep?:string}}|undefined,walletAddress:string|undefined,now:number){
 return Boolean(snapshot&&walletAddress&&snapshot.authority.status==='active'&&snapshot.authority.expiry*1000>now&&snapshot.authority.walletAddress.toLowerCase()===walletAddress.toLowerCase()&&snapshot.lifecycle?.operation!=='revoke'&&!snapshot.lifecycle?.pendingStep);
}
