import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

export async function runMemoryAgent(opts:{ctx:any;model:any;auth?:any;thinking:string;maxTurns:number;system:string;prompt:string;tool:AgentTool<any>;signal?:AbortSignal}){
 const auth=opts.auth??await opts.ctx.modelRegistry.getApiKeyAndHeaders(opts.model);if(!auth.ok)throw new Error(auth.error||`no API key for provider "${opts.model.provider}"`);if(!auth.apiKey)throw new Error(`no API key for provider "${opts.model.provider}"`);
 let turns=0;const streamFn:any=(model:any,context:any,o:any)=>streamSimple(model,context,{...o,apiKey:auth.apiKey,headers:auth.headers,baseUrl:auth.baseUrl,env:auth.env,maxTokens:model.maxTokens>0?Math.min(model.maxTokens,32_000):32_000});
 const agent=new Agent({streamFn,toolExecution:"sequential",initialState:{systemPrompt:opts.system,model:opts.model,thinkingLevel:(opts.model.reasoning&&opts.thinking!=="off"?opts.thinking:"off") as any,tools:[opts.tool],messages:[]},shouldStopAfterTurn:()=>++turns>=opts.maxTurns});
 if(opts.signal)opts.signal.addEventListener("abort",()=>agent.abort(),{once:true});await agent.prompt(opts.prompt);const last=[...agent.state.messages].reverse().find((m:any)=>m.role==="assistant") as any;if(last?.stopReason==="error")throw new Error(last.errorMessage||"memory agent failed");return agent.state.messages;
}
export const observationSchema=Type.Object({observations:Type.Array(Type.Object({timestamp:Type.String(),content:Type.String(),relevance:Type.Union([Type.Literal("low"),Type.Literal("medium"),Type.Literal("high"),Type.Literal("critical")]),sourceEntryIds:Type.Array(Type.String())}))});
export const reflectionSchema=Type.Object({reflections:Type.Array(Type.Object({content:Type.String(),supportingObservationIds:Type.Array(Type.String())}))});
export const dropSchema=Type.Object({ids:Type.Array(Type.String()),reason:Type.Optional(Type.String())});
