import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function formatTokens(n:number){if(n<1_000)return `${Math.round(n)}`;if(n<10_000)return `${(n/1_000).toFixed(1)}k`;if(n<1_000_000)return `${Math.round(n/1_000)}k`;if(n<10_000_000)return `${(n/1_000_000).toFixed(1)}M`;return `${Math.round(n/1_000_000)}M`}
export function truncate(text:string,width:number){if(width<=0)return "";if(text.length<=width)return text;if(width<=3)return text.slice(0,width);return text.slice(0,width-3)+"..."}
export function justify(left:string,right:string,width:number){if(width<=0)return "";if(right.length+2>=width)return truncate(right,width);const room=width-right.length-2;if(left.length<=room)return left+" ".repeat(width-left.length-right.length)+right;return truncate(left,room)+"  "+right}
function sanitize(s:string){return s.replace(/[\r\n\t]/g," ").replace(/ +/g," ").trim()}

export default function(pi:ExtensionAPI){
 let enabled=process.env.PI_DESCRIPTIVE_FOOTER!=="0";
 const install=(ctx:any)=>ctx.ui.setFooter((tui:any,theme:any,data:any)=>{const unsub=typeof data.onBranchChange==="function"?data.onBranchChange(()=>tui.requestRender()):()=>{};return {dispose:unsub,invalidate(){},render(width:number){
   let input=0,output=0,cacheRead=0,cacheWrite=0,cost=0;for(const e of ctx.sessionManager.getEntries()){if(e.type==="message"&&e.message?.role==="assistant"){const u=e.message.usage||{};input+=u.input||0;output+=u.output||0;cacheRead+=u.cacheRead||0;cacheWrite+=u.cacheWrite||0;cost+=u.cost?.total||0}}
   let cwd=ctx.sessionManager.getCwd();const home=process.env.HOME||process.env.USERPROFILE;if(home&&cwd.startsWith(home))cwd="~"+cwd.slice(home.length);const branch=data.getGitBranch?.();if(branch)cwd+=` (${branch})`;const name=ctx.sessionManager.getSessionName?.();if(name)cwd+=` • ${name}`;
   const usage=ctx.getContextUsage?.();const pct=typeof usage?.percent==="number"?`${usage.percent.toFixed(1)}%`:"?";const win=usage?.contextWindow||ctx.model?.contextWindow;const context=`context: ${pct}${win?` of ${formatTokens(win)}`:""}`;
   const models=ctx.modelRegistry?.getAvailable?.()||[];const providers=new Set(models.map((m:any)=>m.provider));const components:string[]=[];if(providers.size>1&&ctx.model?.provider)components.push(ctx.model.provider);components.push(ctx.model?.id||"no model");if(ctx.model?.reasoning)components.push("reasoning enabled");const left=`${context}   |   model: ${components.join(" / ")}`;
   const sub=ctx.model&&ctx.modelRegistry?.isUsingOAuth?.(ctx.model);const cached=cacheRead+cacheWrite,totalIn=input+cached;const suffix=cached>0&&totalIn>0?` ($${Math.round(cached/totalIn*100)}%)`:"";const right=`cost: $${cost.toFixed(3)}${sub?" (sub)":""}   |   total traffic: ↑ ${formatTokens(input)}${suffix}, ↓ ${formatTokens(output)}`;
   const lines=[truncate(cwd,width),justify(left,right,width)];const statuses=data.getExtensionStatuses?.();if(statuses?.size){const status=[...statuses.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>sanitize(String(v))).join(" ");lines.push(truncate(status,width))}return lines.map(x=>theme.fg("dim",x));
 }} });
 pi.on("session_start",(_e,ctx)=>{if(enabled)install(ctx)});
 pi.registerCommand("descriptive-footer",{description:"Toggle the descriptive footer",handler:async(_args,ctx)=>{enabled=!enabled;if(enabled){install(ctx);ctx.ui.notify("Descriptive footer enabled","info")}else{ctx.ui.setFooter(undefined);ctx.ui.notify("Default footer restored","info")}}});
}
