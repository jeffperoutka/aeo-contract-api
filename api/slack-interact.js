/**
 * AEO Labs — Slack Interaction Handler
 *
 * Receives modal form submissions from the /new-contract slash command.
 * Extracts field values, fires off the pipeline to /api/slack-contract
 * (a separate function invocation), and immediately responds to Slack
 * to close the modal.
 *
 * ARCHITECTURE (Vercel Hobby plan safe):
 * 1. Parse the Slack payload and extract form values
 * 2. Fire HTTP request to /api/slack-contract (separate function)
 * 3. Wait for the request to be sent over the wire
 * 4. Respond to Slack with { response_action: "clear" } to close modal
 *
 * The /api/slack-contract function runs independently and handles:
 * - Calling /api/generate-and-send (the main pipeline)
 * - Posting results to #contracts-invoices
 *
 * POST /api/slack-interact
 */

const https = require("https");
const querystring = require("querystring");

// ==================== PAYLOAD PARSING ====================

function extractPayload(req) {
  let raw = req.body;

  if (raw && typeof raw === "object" && raw.payload) {
    try { return JSON.parse(raw.payload); }
    catch(e) { return null; }
  }

  if (raw && typeof raw === "string") {
    try {
      const parsed = querystring.parse(raw);
      if (parsed.payload) return JSON.parse(parsed.payload);
    } catch(e) {}
    try { return JSON.parse(raw); } catch(e) {}
  }

  if (raw && typeof raw === "object" && raw.type) return raw;
  return null;
}

// ==================== FORM VALUE EXTRACTION ====================

function extractFormValues(viewState) {
  const values = viewState.values || {};
  const result = {};

  for (const [blockId, actions] of Object.entries(values)) {
    const action = actions.value || actions[Object.keys(actions)[0]];
    if (!action) continue;

    if (action.type === "static_select" && action.selected_option) {
      result[blockId] = action.selected_option.value;
    } else if (action.value !== undefined) {
      result[blockId] = action.value;
    }
  }

  return result;
}

// ==================== FIRE-AND-FORGET HTTP REQUEST ====================

/**
 * Sends an HTTP request to /api/slack-contract and resolves
 * as soon as the request body has been flushed to the network.
 * We do NOT wait for the response — the target function runs independently.
 */
function fireAndForget(formData) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(formData);
    const options = {
      hostname: "aeo-contract-api.vercel.app",
      port: 443,
      path: "/api/slack-contract",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, () => {
      // Response received — but we don't care, we already resolved
    });

    req.on("error", (err) => {
      console.log("SLACK-INTERACT: fire-and-forget error (non-fatal):", err.message);
    });

    // Write the body and flush — resolve once data is sent
    req.write(bodyStr, () => {
      req.end();
      // Small delay to ensure TCP data is flushed
      setTimeout(resolve, 200);
    });
  });
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  console.log("SLACK-INTERACT: Handler invoked, method=" + req.method);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const payload = extractPayload(req);
  if (!payload) {
    console.error("SLACK-INTERACT: No payload");
    return res.status(200).send("");
  }

  if (payload.type !== "view_submission") {
    return res.status(200).send("");
  }

  if (!payload.view || payload.view.callback_id !== "new_contract_submit") {
    return res.status(200).send("");
  }

  // Extract form values
  const formValues = extractFormValues(payload.view.state);
  console.log("SLACK-INTERACT: formValues=" + JSON.stringify(formValues));

  const formData = {
    contract_type: formValues.contract_type || "",
    client_company: (formValues.client_company || "").trim(),
    client_first: (formValues.client_first || "").trim(),
    client_last: (formValues.client_last || "").trim(),
    client_title: (formValues.client_title || "").trim(),
    client_email: (formValues.client_email || "").trim().toLowerCase(),
    amount: String(formValues.amount || "").replace(/[$,\s]/g, ""),
    scope: (formValues.scope || "").trim()
  };

  console.log("SLACK-INTERACT: company=" + formData.client_company + " email=" + formData.client_email);

  // STEP 1: Fire the request to /api/slack-contract FIRST
  // This creates a NEW Vercel function invocation that runs independently
  console.log("SLACK-INTERACT: Firing pipeline to /api/slack-contract...");
  await fireAndForget(formData);
  console.log("SLACK-INTERACT: Pipeline request sent");

  // STEP 2: Respond to Slack to close the modal
  // Even if this function gets killed after res.send(), the pipeline
  // is already running in the separate /api/slack-contract function
  console.log("SLACK-INTERACT: Closing modal");
  return res.status(200).json({ response_action: "clear" });
};
