// api/lib/supplier-client.js
import axios from 'axios';
import { getSupplierConfigByCode } from './supplier-registry-db.js';

// Mini templating: ganti {{var}} dari context
function render(tpl, ctx) {
  if (tpl == null) return tpl;
  if (typeof tpl === 'string') {
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const keys = k.split('.');
      let v = ctx;
      for (const kk of keys) v = v?.[kk];
      return v == null ? '' : String(v);
    });
  } else if (Array.isArray(tpl)) {
    return tpl.map(x => render(x, ctx));
  } else if (typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = render(v, ctx);
    return out;
  }
  return tpl;
}

function getPath(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

function normalizeStatus(raw, map) {
  if (raw == null) return 'PENDING';
  const key = String(raw).toUpperCase();
  return map?.[key] || map?.[raw] || key;
}

/**
 * callSupplier(op, supplierCode, ctx)
 * ctx: { baseUrl, apiKey, ref, sku, msisdn, customerNo, amount, signature?, ... }
 */
export async function callSupplier(op, supplierCode, ctx) {
  const sc = await getSupplierConfigByCode(supplierCode);
  const conf = sc.ops?.[op];
  if (!conf) throw new Error(`Operation ${op} tidak dikonfigurasi untuk ${supplierCode}`);

  const baseUrl = ctx.baseUrl?.replace(/\/+$/, '') || '';
  const url = baseUrl + render(conf.path, ctx);
  const method = String(conf.method || 'POST').toUpperCase();

  const headers = { ...(sc.defaults?.headers || {}), ...(render(conf.headers || {}, ctx)) };
  const body = render(conf.body || {}, ctx);
  const timeout = Number(sc.defaults?.timeoutMs || 25000);

  let resp;
  try {
    resp = await axios.request({
      url, method, headers,
      data: method === 'GET' ? undefined : body,
      params: method === 'GET' ? body : undefined,
      timeout
    });
  } catch (e) {
    return { ok: false, transportError: true, error: e?.message || String(e) };
  }

  const data = resp?.data;
  const map = conf.response?.statusMap || {};
  const statusRaw = getPath(data, conf.response?.statusPath);
  const status = normalizeStatus(statusRaw, map);
  const message = getPath(data, conf.response?.messagePath) ?? status;
  const supplierRef = getPath(data, conf.response?.supplierRefPath) ?? null;

  const amountStr = conf.response?.amountPath ? getPath(data, conf.response.amountPath) : null;
  const adminFeeStr = conf.response?.adminFeePath ? getPath(data, conf.response.adminFeePath) : null;

  const extra = {};
  if (conf.response?.extraPaths) {
    for (const [k, pth] of Object.entries(conf.response.extraPaths)) {
      extra[k] = getPath(data, pth) ?? null;
    }
  }

  return {
    ok: true,
    data,
    norm: {
      status: String(status).toUpperCase(),
      message,
      supplierRef,
      amount: amountStr != null ? BigInt(amountStr) : null,
      adminFee: adminFeeStr != null ? BigInt(adminFeeStr) : null,
      extra
    }
  };
}
