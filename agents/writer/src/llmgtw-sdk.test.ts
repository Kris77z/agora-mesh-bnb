import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAI} from '@ai-sdk/openai';
import {generateText,tool} from 'ai';
import {z} from 'zod';
import {createLlmgtwFetch} from '@rebel/shared';
test('existing SDK executes a tool and submits its result through the Gemini adapter',async()=>{
 let requests=0;let executed=0;
 const transport:typeof fetch=async(_,init)=>{
  const body=JSON.parse(init?.body as string);requests++;
  assert.equal(body.max_completion_tokens,128);assert.equal(body.stream,false);
  assert.equal(body.max_tokens,undefined);assert.equal(body.temperature,undefined);
  const message=requests===1 ? {role:'assistant',content:null,tool_calls:[{id:'multiply_0_0',type:'function',function:{name:'multiply',arguments:'{"a":17,"b":23}'}}]} : {role:'assistant',content:'391'};
  if(requests===2){const result=body.messages.find((m:{role:string})=>m.role==='tool');assert.equal(result.tool_call_id,'multiply_0_0');assert.equal(JSON.parse(result.content).result,391);}
  assert.ok(requests<=2);
  return Response.json({id:'offline-test',object:'chat.completion',created:0,model:'gemini-3.1-pro-preview',choices:[{index:0,message,finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:46,completion_tokens:20,total_tokens:71,reasoning_tokens:5}});
 };
 const provider=createOpenAI({apiKey:'offline-placeholder',baseURL:'https://gateway.llmgtw.io/v1',compatibility:'compatible',fetch:createLlmgtwFetch(transport)});
 const result=await generateText({model:provider.chat('gemini-3.1-pro-preview'),maxRetries:0,maxTokens:128,maxSteps:2,prompt:'Multiply 17 by 23 using the tool.',tools:{multiply:tool({description:'Local multiplication',parameters:z.object({a:z.number(),b:z.number()}),execute:async({a,b})=>{executed++;return {result:a*b};}})}});
 assert.equal(result.text,'391');assert.equal(executed,1);assert.equal(requests,2);
});
