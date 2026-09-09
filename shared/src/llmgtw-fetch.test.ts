import test from 'node:test';
import assert from 'node:assert/strict';
import {createLlmgtwFetch} from './llmgtw-fetch.js';
const endpoint='https://gateway.llmgtw.io/v1/chat/completions';
test('Gemini request matches JSON probe while preserving tools, auth and cancellation',async()=>{
 const controller=new AbortController();let count=0;
 const tools=[{type:'function',function:{name:'multiply'}}];
 const transport:typeof fetch=async(input,init)=>{
  count++;assert.equal(input,endpoint);assert.equal(init?.signal,controller.signal);
  assert.deepEqual(init?.headers,{'Authorization':'Bearer offline-test'});
  assert.deepEqual(JSON.parse(init?.body as string),{model:'gemini-3.1-pro-preview',max_completion_tokens:128,stream:false,tools,tool_choice:'auto'});
  assert.equal(init?.redirect,'error');return Response.json({choices:[]});
 };
 await createLlmgtwFetch(transport)(endpoint,{method:'POST',headers:{Authorization:'Bearer offline-test'},signal:controller.signal,body:JSON.stringify({model:'gemini-3.1-pro-preview',max_tokens:128,temperature:0,tools,tool_choice:'auto'})});
 assert.equal(count,1);
});
test('does not retry HTTP failure, network failure or change the response',async()=>{
 let count=0;const failed=new Response('unavailable',{status:500});
 const http:typeof fetch=async()=>{count++;return failed;};
 const init={body:JSON.stringify({model:'gemini-3.1-pro-preview',max_tokens:128})};
 assert.equal(await createLlmgtwFetch(http)(endpoint,init),failed);assert.equal(count,1);
 const network:typeof fetch=async()=>{count++;throw new Error('connection lost');};
 await assert.rejects(createLlmgtwFetch(network)(endpoint,init),/connection lost/);assert.equal(count,2);
});
test('leaves other routes and models unchanged',async()=>{
 for(const [url,model] of [[endpoint,'gpt-5.1'],['https://api.example.com/v1/chat/completions','gemini-3.1-pro-preview']]){
  const init={body:JSON.stringify({model,max_tokens:128,temperature:0})};
  const transport:typeof fetch=async(_,actual)=>{assert.equal(actual,init);return Response.json({});};
  await createLlmgtwFetch(transport)(url,init);
 }
});
test('preserves explicit completion budget and rejects streaming before dispatch',async()=>{
 let count=0;const transport:typeof fetch=async(_,init)=>{count++;assert.equal(JSON.parse(init?.body as string).max_completion_tokens,64);return Response.json({});};
 await createLlmgtwFetch(transport)(endpoint,{body:JSON.stringify({model:'gemini-3.1-pro-preview',max_tokens:128,max_completion_tokens:64})});
 await assert.rejects(createLlmgtwFetch(transport)(endpoint,{body:JSON.stringify({model:'gemini-3.1-pro-preview',stream:true})}),/non-streaming/);assert.equal(count,1);
});
