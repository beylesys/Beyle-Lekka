export function isValidGSTIN(g){ return !!g && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/i.test(g); }
export function stateCodeFromGSTIN(g){ return isValidGSTIN(g) ? g.slice(0,2) : null; }
export function round2(n){ return Math.round(Number(n||0)*100)/100; }
export function isInterState(origin,pos,assumeInterIfUnknown=false){
  if(!origin||!pos) return !!assumeInterIfUnknown; return String(origin)!==String(pos);
}
export function computeGSTBreakup(items=[], inter){
  let taxable=0, igst=0, cgst=0, sgst=0;
  for(const it of items){
    const qty=Number(it.qty||1), rate=Number(it.rate||it.price||0);
    const amt=(it.amount!=null)?Number(it.amount):qty*rate;
    const r=Number(it.gstRate||it.gst||0)/100;
    taxable+=amt; const tax=amt*r;
    if(inter) igst+=tax; else { cgst+=tax/2; sgst+=tax/2; }
  }
  const totalTax=round2(igst+cgst+sgst), gross=round2(taxable+totalTax);
  return { taxable:round2(taxable), igst:round2(igst), cgst:round2(cgst), sgst:round2(sgst), totalTax, gross };
}
