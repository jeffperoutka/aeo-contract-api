/**
 * TEMPORARY cleanup endpoint — lists and deletes all test data from
 * Stripe (void invoices, cancel subscriptions, delete customers)
 * and SignNow (delete all documents).
 *
 * DELETE THIS FILE after use.
 *
 * GET  /api/cleanup?action=list     — List all items
 * POST /api/cleanup?action=execute  — Actually clean up
 */

const https = require("https");

// ==================== HTTP HELPERS ====================

function apiRequest(hostname, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path, method, headers: { ...headers } };
    if (body && method !== "GET") {
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.substring(0, 500) }); }
      });
    });
    req.on("error", reject);
    if (body && method !== "GET") req.write(body);
    req.end();
  });
}

function stripeReq(method, path, formData) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("No STRIPE_SECRET_KEY");
  const headers = { "Authorization": "Basic " + Buffer.from(key + ":").toString("base64") };
  if (formData && method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  return apiRequest("api.stripe.com", method, "/v1" + path, headers, formData || undefined);
}

async function getSignNowToken() {
  const clientId = process.env.SIGNNOW_CLIENT_ID || "7c3d39e0897e5e3f05cf71f21559da56";
  const clientSecret = process.env.SIGNNOW_CLIENT_SECRET || "5a2b434dfe8c1370e1a0b6a0f2b7c4b5";
  const email = process.env.SIGNNOW_EMAIL || "jeff@aeolabs.com";
  const password = process.env.SIGNNOW_PASSWORD || "AeoLabs2025!";

  const body = "grant_type=password&username=" + encodeURIComponent(email) + "&password=" + encodeURIComponent(password);
  const res = await apiRequest("api.signnow.com", "POST", "/oauth2/token", {
    "Authorization": "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded"
  }, body);
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    throw new Error("SignNow auth failed: " + JSON.stringify(res.body || res.raw));
  }
  return res.body.access_token;
}

// ==================== STRIPE CLEANUP ====================

async function listStripe() {
  const results = { invoices: [], subscriptions: [], customers: [] };

  // List all invoices
  const inv = await stripeReq("GET", "/invoices?limit=100", "");
  if (inv.body && inv.body.data) {
    results.invoices = inv.body.data.map(i => ({
      id: i.id, status: i.status, amount: i.amount_due,
      customer: i.customer, description: i.description || i.lines?.data?.[0]?.description || "N/A",
      created: new Date(i.created * 1000).toISOString()
    }));
  }

  // List all subscriptions
  const subs = await stripeReq("GET", "/subscriptions?limit=100&status=all", "");
  if (subs.body && subs.body.data) {
    results.subscriptions = subs.body.data.map(s => ({
      id: s.id, status: s.status, customer: s.customer,
      created: new Date(s.created * 1000).toISOString()
    }));
  }

  // List all customers
  const cust = await stripeReq("GET", "/customers?limit=100", "");
  if (cust.body && cust.body.data) {
    results.customers = cust.body.data.map(c => ({
      id: c.id, name: c.name, email: c.email,
      created: new Date(c.created * 1000).toISOString()
    }));
  }

  return results;
}

async function cleanStripe() {
  const log = [];

  // 1. Cancel all active subscriptions
  const subs = await stripeReq("GET", "/subscriptions?limit=100", "");
  if (subs.body && subs.body.data) {
    for (const sub of subs.body.data) {
      if (sub.status !== "canceled") {
        const r = await stripeReq("DELETE", "/subscriptions/" + sub.id, "");
        log.push("Canceled subscription " + sub.id + " -> " + r.status);
      }
    }
  }

  // 2. Void all open/draft invoices
  const inv = await stripeReq("GET", "/invoices?limit=100", "");
  if (inv.body && inv.body.data) {
    for (const invoice of inv.body.data) {
      if (invoice.status === "draft") {
        // Delete draft invoices
        const r = await stripeReq("DELETE", "/invoices/" + invoice.id, "");
        log.push("Deleted draft invoice " + invoice.id + " -> " + r.status);
      } else if (invoice.status === "open") {
        // Void open invoices
        const r = await stripeReq("POST", "/invoices/" + invoice.id + "/void", "");
        log.push("Voided open invoice " + invoice.id + " -> " + r.status);
      } else {
        log.push("Skipped invoice " + invoice.id + " (status: " + invoice.status + ")");
      }
    }
  }

  // 3. Delete all customers (this also removes their payment methods etc)
  const cust = await stripeReq("GET", "/customers?limit=100", "");
  if (cust.body && cust.body.data) {
    for (const customer of cust.body.data) {
      const r = await stripeReq("DELETE", "/customers/" + customer.id, "");
      log.push("Deleted customer " + customer.id + " (" + (customer.name || customer.email) + ") -> " + r.status);
    }
  }

  return log;
}

// ==================== SIGNNOW CLEANUP ====================

async function listSignNow() {
  const token = await getSignNowToken();
  const res = await apiRequest("api.signnow.com", "GET", "/user/documentsv2?limit=100&offset=0", {
    "Authorization": "Bearer " + token
  });

  if (res.status !== 200) {
    return { error: "Failed to list docs: " + JSON.stringify(res.body || res.raw) };
  }

  const docs = res.body || [];
  // documentsv2 might return an array or an object with data
  const docList = Array.isArray(docs) ? docs : (docs.data || []);

  return docList.map(d => ({
    id: d.id,
    name: d.document_name || d.original_filename || "Unknown",
    created: d.created || d.updated || "N/A"
  }));
}

async function cleanSignNow() {
  const token = await getSignNowToken();
  const log = [];

  const res = await apiRequest("api.signnow.com", "GET", "/user/documentsv2?limit=100&offset=0", {
    "Authorization": "Bearer " + token
  });

  const docs = res.body || [];
  const docList = Array.isArray(docs) ? docs : (docs.data || []);

  for (const doc of docList) {
    const docId = doc.id;
    const delRes = await apiRequest("api.signnow.com", "DELETE", "/document/" + docId, {
      "Authorization": "Bearer " + token
    });
    log.push("Deleted doc " + docId + " (" + (doc.document_name || doc.original_filename || "?") + ") -> " + delRes.status);
  }

  return log;
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  const action = req.query?.action || (req.url.includes("action=execute") ? "execute" : "list");

  console.log("CLEANUP: action=" + action);

  try {
    if (action === "execute") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Use POST for execute" });
      }
      const stripeLog = await cleanStripe();
      const signnowLog = await cleanSignNow();
      return res.status(200).json({ success: true, stripe: stripeLog, signnow: signnowLog });
    } else {
      // List everything
      const stripe = await listStripe();
      const signnow = await listSignNow();
      return res.status(200).json({ stripe, signnow });
    }
  } catch(err) {
    console.error("CLEANUP error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
