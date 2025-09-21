import { query } from "../../services/db.js";

export async function getLedger(name){
  if(!name) return null;
  const { rows } = await query(
    "SELECT account_code AS code, name, type, normal_balance, is_active FROM chart_of_accounts WHERE (account_code=$1 OR name=$1) LIMIT 1",
    [name]
  );
  return rows[0] || null;
}

export async function isPeriodClosed(/* isoDate */){
  // Hook into a period-lock table later if needed
  return false;
}

export async function hasDuplicateInvoice({ number, date }){
  const { rows } = await query("SELECT id FROM documents WHERE number=$1 AND date=$2 LIMIT 1",[number||"",date||""]);
  return rows.length>0;
}

export async function canIssueNumber(docType){
  const t = (docType==="payment_voucher") ? "voucher" : docType;
  const { rows } = await query("SELECT 1 FROM document_series WHERE doc_type=$1",[t]);
  return rows.length>0;
}

export async function getOnHand(itemCode){
  // If you didn't add inventory tables yet, you can return a stub or derive from elsewhere
  try{
    const { rows } = await query(`
      SELECT i.id, i.code, i.name, i.stock_tracked,
             COALESCE(SUM(sl.qty_in) - SUM(sl.qty_out), 0) AS onhand
      FROM items i
      LEFT JOIN stock_ledger sl ON sl.item_id = i.id
      WHERE i.code = $1
    `,[itemCode]);
    return rows[0] || null;
  }catch(e){
    return null; // tables may not exist yet
  }
}
