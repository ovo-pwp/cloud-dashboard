import XLSX from 'xlsx';
const p = 'C:/Users/Administrator/Desktop/应收看板-数据导出/(已开票未回款-每天)未回款.xlsx';
const wb = XLSX.readFile(p);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
const hdr = rows[0].map(v => String(v ?? '').trim());
const custIdx = hdr.findIndex(h => h.includes('挂账'));
console.log('sheet=', wb.SheetNames[0], 'rows=', rows.length, '挂账客户 col=', custIdx);
let cn = 0, naive = 0;
const samples = [];
for (let i = 1; i < rows.length; i++) {
  const v = String(rows[i][custIdx] ?? '').trim();
  if (!v) continue;
  if (/[^\x00-\x7f]/.test(v)) cn++; else naive++;
  if (samples.length < 10) samples.push(v);
}
console.log('含中文行=', cn, ' ASCII-only行=', naive);
console.log('样例=', JSON.stringify(samples));