export function emptyResult(){ return { errors:[], warnings:[], info:[] }; }
export function combine(a,b){
  return { errors:[...(a.errors||[]),...(b.errors||[])],
           warnings:[...(a.warnings||[]),...(b.warnings||[])],
           info:[...(a.info||[]),...(b.info||[])] };
}
export const err =(code,msg,path=null,meta={})=>({code,message:msg,path,meta,severity:"errors"});
export const warn=(code,msg,path=null,meta={})=>({code,message:msg,path,meta,severity:"warnings"});
export const info=(code,msg,path=null,meta={})=>({code,message:msg,path,meta,severity:"info"});
