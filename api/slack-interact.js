/**
 * AEO Labs — Slack Interaction Handler
 *
 * Receives modal form submissions from the /new-contract slash command.
 * Extracts field values, responds 200 to Slack immediately, then fires
 * off the pipeline via /api/slack-contract (a SEPARATE function invocation)
 * so it doesn't hit Vercel's function timeout.
 *
 * Architecture:
 * 1. Slack sends view_submission → this handler
 * 2. This handler responds 200 immediately (Slack requires < 3 seconds)
 * 3. This handler fires HTTP POST to /api/slack-contract with form data
 * 4. /api/slack-contract runs the full pipeline + posts results to Slack
 *
 * POST /api/slack-interact
 */

const https = require("https");
const querystring = require("querystring");

// ==================== PAYLOAD PARSING ====================

function extractPayload(req) {
  let raw = req.body;

  // If Vercel parsed form-urlencoded, req.body is an object with a "payload" key
  if (raw && typeof raw === "object" && raw.payload) {
    try {
      return JSON.parse(raw.payload);
    } catch(e) {
      console.error("SLACK-INTERACT: Failed to parse payload from object:", e.message);
      return null;
    }
  }

  // If req.body is a string (raw form-urlencoded), parse it
  if (raw && typeof raw === "string") {
    try {
      const parsed = querystring.parse(raw);
      if (parsed.payload) {
        return JSON.parse(parsed.payload);
      }
    } catch(e) {
      console.error("SLACK-INTERACT: Failed to parse string body:", e.message);
    }
    // Maybe it's raw JSON
    try {
      return JSON.parse(raw);
    } catch(e) {
      // not JSON either
    }
  }

  // If body is already the payload object (unlikely but handle it)
  if (raw && typeof raw === "object" && raw.type) {
    return raw;
  }

  console.error("SLACK-INTERACT: Could not extract payload. Body type:", typeof raw,
    "Keys:", raw ? Object.keys(raw).join(",") : "null");
  return null;
}

// ==================== FORM VALUE EXTRACTION ====================

function extractFormValues(viewState) {
  const values = viewState.values || {};
  const result = {};

  for (const [blockId, actions] of Object.entries(values)) {
    // Slack structure: values[block_id][action_id] = { type, value/selected_option }
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

// ==================== FIRE-AND-FORGET HTTP ====================

/**
 * Send an HTTP POST request WITHOUT awaiting the response.
 * This triggers a new Vercel function invocation that runs independently.
 * We just need to ensure the request is sent before this function exits.
 */
function fireAndForget(hostname, pathStr, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path: pathStr,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, (res) => {
      // We don't need the response, but we consume it to prevent memory leaks
      res.resume();
      resolve({ sent: true, status: res.statusCode });
    });

    req.on("error", (err) => {
      console.error("SLACK-INTERACT: Fire-and-forget request error:", err.message);
      resolve({ sent: false, error: err.message });
    });

    // Send the request body and finalize
    req.write(bodyStr);
    req.end(() => {
      // req.end callback fires when data has been flushed to the OS
      console.log("SLACK-INTERACT: Fire-and-forget request sent to " + pathStr);
      resolve({ sent: true });
    });
  });
}

// ==================== SLACK API HELPER ====================

function slackPostMessage(token, channel, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, text });
    const options = {
      hostname: "slack.com",
      port: 443,
      path: "/api/chat.postMessage",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false }); }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  console.log("SLACK-INTERACT: Received request");
  console.log("SLACK-INTERACT: Method=" + req.method);
  console.log("SLACK-INTERACT: Content-Type=" + (req.headers["content-type"] || "none"));
  console.log("SLACK-INTERACT: Body type=" + typeof req.body);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Extract the Slack payload
  const payload = extractPayload(req);
  if (!payload) {
    console.error("SLACK-INTERACT: Could not extract payload, returning 200");
    return res.status(200).send("");
  }

  console.log("SLACK-INTERACT: Payload type=" + payload.type);

  // Only handle view_submission for our contract modal
  if (payload.type !== "view_submission") {
    console.log("SLACK-INTERACT: Ignoring type:", payload.type);
    return res.status(200).send("");
  }

  if (!payload.view || payload.view.callback_id !== "new_contract_submit") {
    console.log("SLACK-INTERACT: Ignoring callback_id:", payload.view && payload.view.callback_id);
    return res.status(200).send("");
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const userId = payload.user && payload.user.id;

  // Extract form values from the modal
  const formValues = extractFormValues(payload.view.state);
  console.log("SLACK-INTERACT: Extracted form values:", JSON.stringify(formValues));

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

  console.log("SLACK-INTERACT: Form data:", JSON.stringify({
    type: formData.contract_type,
    company: formData.client_company,
    email: formData.client_email,
    amount: formData.amount
  }));

  // CRITICAL: Respond 200 to Slack FIRST (must be within 3 seconds)
  res.status(200).send("");

  // Now fire off the pipeline via /api/slack-contract (separate function invocation)
  // This avoids the Vercel function timeout issue — slack-contract gets its own timeout
  try {
    // Send a "processing" DM to the user (quick, non-blocking)
    if (token && userId) {
      const dmResult = await slackPostMessage(
        token,
        userId,
        `:hourglass_flowing_sand: Generating contract for *${formData.client_company}*... This takes about 15 seconds. Results will appear in <#${process.env.SLACK_CHANNEL_ID || "C0AHK69NL8K"}>.`
      );
      console.log("SLACK-INTERACT: DM sent ok=" + dmResult.ok);
    }

    // Fire the pipeline request to /api/slack-contract
    // This creates a NEW Vercel function invocation with its own timeout
    console.log("SLACK-INTERACT: Firing pipeline via /api/slack-contract...");
    const fireResult = await fireAndForget(
      "aeo-contract-api.vercel.app",
      "/api/slack-contract",
      formData
    );
    console.log("SLACK-INTERACT: Fire-and-forget result:", JSON.stringify(fireResult));

  } catch(err) {
    console.error("SLACK-INTERACT: Error after responding:", err.message);
    // Try to notify the user something went wrong
    if (token && userId) {
      try {
        await slackPostMessage(token, userId,
          `:x: Something went wrong starting the contract pipeline for *${formData.client_company}*: ${err.message}`
        );
      } catch(e) {
        console.error("SLACK-INTERACT: Could not even DM error:", e.message);
      }
    }
  }
};
