// api/lib/supplier-registry.js
import fs from 'fs';
import path from 'path';

let REG = null;

function loadJsonConfig() {
  const p = process.env.SUPPLIER_CONFIG_PATH || path.join(process.cwd(), 'config', 'suppliers.json');
  const raw = fs.readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);

  if (!cfg || !cfg.suppliers) throw new Error('suppliers.json invalid: missing suppliers');
  for (const [code, sup] of Object.entries(cfg.suppliers)) {
    if (!sup.ops || typeof sup.ops !== 'object') {
      throw new Error(`Supplier ${code} invalid: missing ops`);
    }
  }
  return cfg;
}

export function getRegistry() {
  if (!REG) REG = loadJsonConfig();
  return REG;
}

export function getSupplierConfig(supplierCode) {
  const reg = getRegistry();
  const sup = reg.suppliers?.[supplierCode];
  if (!sup) throw new Error(`Supplier config not found for code=${supplierCode}`);
  return { defaults: reg.defaults || {}, ...sup };
}
