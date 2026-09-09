import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBoundedSubmission,isAuthorityReady} from './bounded-submission';
import {boundedRunView} from './bounded-run-view';
test('an ambiguous submission reuses its idempotency key; changed input is blocked',()=>{
 const access={id:'a',token:'offline'};
 const first=prepareBoundedSubmission(access,' audit ','commander','zh-CN',()=> 'one');
 const retry=prepareBoundedSubmission(first,'audit','commander','zh-CN',()=>{throw new Error('must not allocate')});
 assert.equal(retry.requestKey,'one');
 assert.throws(()=>prepareBoundedSubmission(first,'different','commander','zh-CN',()=> 'two'),/unknown outcome/);
 assert.throws(()=>prepareBoundedSubmission(first,'audit','single','zh-CN',()=> 'two'),/unknown outcome/);
 const next=prepareBoundedSubmission({...first,missionId:'completed-task'},'audit','commander','zh-CN',()=> 'two');
 assert.equal(next.requestKey,'two');assert.equal(next.missionId,undefined);
});
test('expired, pending, revoking and mismatched wallets cannot start',()=>{
 const s={authority:{status:'active',expiry:200,walletAddress:'0xAB'},lifecycle:{operation:'provision'}};
 assert.equal(isAuthorityReady(s,'0xab',100000),true);
 assert.equal(isAuthorityReady(s,'0xab',200000),false);
 assert.equal(isAuthorityReady(s,'0xcd',100000),false);
 assert.equal(isAuthorityReady({...s,lifecycle:{operation:'revoke'}},'0xab',100000),false);
 assert.equal(isAuthorityReady({...s,lifecycle:{operation:'provision',pendingStep:'grantSession'}},'0xab',100000),false);
 assert.equal(isAuthorityReady(undefined,'0xab',100000),false);
});
test('timeline uses saved trace data and shows interrupted runs as needing attention',()=>{
 const events=[{type:'payment_state',at:'2026-09-09T00:00:00Z',data:{status:'settled'}}];
 const running={status:'running',events};
 assert.equal(boundedRunView(running).status,'RUNNING');
 assert.equal(boundedRunView(running).events,events);
 assert.equal(boundedRunView({...running,recoveryRequired:true}).status,'ERROR');
 assert.equal(boundedRunView({...running,recoveryRequired:true,recovery:{status:'running',message:'checking'}}).status,'RUNNING');
 assert.equal(boundedRunView({status:'completed',events}).status,'COMPLETED');
 assert.equal(boundedRunView().status,'IDLE');
});
