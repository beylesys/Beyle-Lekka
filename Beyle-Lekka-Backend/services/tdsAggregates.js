// services/tdsAggregates.js
// Return the amount already paid to `payee` under a given TDS `section` in the
// current financial year, up to (but not including) `asOfDateISO`.
export async function getTdsFyAggregate({
  sessionId,
  payee,
  section,
  asOfDateISO,
  fyStartMonth = 4,
  fyStartDay = 1
}) {
  if (!sessionId || !payee || !section) return 0;

  // Compute FY window for the given date
  const asOf = asOfDateISO ? new Date(asOfDateISO) : new Date();
  const y = asOf.getUTCFullYear();
  const fyStart = new Date(Date.UTC(
    asOf.getUTCMonth()+1 >= fyStartMonth ? y : y - 1,
    fyStartMonth - 1,
    fyStartDay || 1
  ));
  const fyEnd = new Date(Date.UTC(
    fyStart.getUTCFullYear() + 1,
    fyStartMonth - 1,
    (fyStartDay || 1)
  ));

  // TODO: implement with your persistence layer:
  // Sum of all CONFIRMED payment vouchers where:
  //  - workspace = sessionId
  //  - payee matches (exact or normalized)
  //  - detected/declared TDS section equals `section`
  //  - date >= fyStart && date < fyEnd
  //  - exclude the document being previewed (if needed, use idempotency key or preview id)
  //
  // Example using a pseudo ORM:
  // const rows = await db.Payments.sum('amount', {
  //   where: {
  //     sessionId,
  //     docType: 'payment_voucher',
  //     status: 'posted',
  //     payee: payee,
  //     tdsSection: section,
  //     date: { $gte: fyStartISO, $lt: fyEndISO }
  //   }
  // });

  // For now, safe fallback (no aggregate found):
  return 0;
}
