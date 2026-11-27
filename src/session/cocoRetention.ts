import { createHash, randomUUID } from "node:crypto";
import { splitConversationTurns } from "../agent/contextCompaction/conversationTurns.js";
import type { Message, Session } from "./types.js";

export type CocoRetentionSlice={sessionId:string;workspaceId:string;source:"coco_chat"|"coco_internal";cutoff:number;digest:string;messages:Message[];previousSummary:string;messageIds:string[]};
const marker=(m:Message)=>m.role==="system"&&m.parts.some(p=>p.type==="context_compaction");
export function cocoRetentionSlice(session:Session,cutoff:number):CocoRetentionSlice|undefined{
  if(!["coco_chat","coco_internal"].includes(session.source??""))return;
  const turns=splitConversationTurns(session.messages).reverse();let end=0;
  for(const turn of turns){if(turn.messages.some(m=>m.createdAt>=cutoff))break;end=turn.endIndex;}
  if(!end)return;
  const messages=session.messages.slice(0,end);
  if(!messages.some(m=>!marker(m)))return;
  const previousSummary=session.messages.flatMap(m=>m.parts.flatMap(p=>p.type==="context_compaction"?[p.summary]:[])).at(-1)??"";
  const digest=createHash("sha256").update(JSON.stringify([messages,previousSummary])).digest("hex");
  return {sessionId:session.id,workspaceId:session.workspaceId,source:session.source as CocoRetentionSlice["source"],cutoff,digest,messages:structuredClone(messages),previousSummary,messageIds:messages.map(m=>m.id)};
}
export function retainedCocoMessages(session:Session,slice:CocoRetentionSlice,summary:string,now:number):Message[]{
  const id=randomUUID();
  return [{id,role:"system",createdAt:now,parts:[{type:"context_compaction",id:randomUUID(),summary:`Retained conversation summary (details before ${new Date(slice.cutoff).toISOString()} were removed by CoCo history retention):\n${summary}`,fromMessageId:id,toMessageId:id,coveredThroughMessageId:id,usedTokensBefore:0,usedTokensAfter:0}]},...session.messages.slice(slice.messages.length).filter(m=>!marker(m))];
}
