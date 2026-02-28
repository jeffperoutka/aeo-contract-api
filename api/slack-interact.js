/**
 * AEO Labs — Slack Interaction Handler
 *
 * Receives modal form submissions from the /new-contract slash command.
 * Extracts field values, responds 200 to Slack immediately, then runs
 * the full pipeline and posts results to Slack.
 *
 * IMPORTANT: maxDuration is set to 60s in vercel.json so the function
 * stays alive after res.send() to complete the pipeline work.
 *
 * POST /api/slack-interact
 */

const https = require("https");
const querystring = require("querystring");

// Slack channel for posting results
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || "C0AHK69NL8K";

// ==================== HTTP HELPERS ====================

function postJSON(hostname, pathStr, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path: pathStr,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...(headers || {})
      },
      timeout: 55000 // 55 second timeout for the request
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.substring(0, 1000) }); }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out after 55s"));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function slackAPI(method, body, token) {
  return postJSON("slack.com", "/api/" + method, body, {
    "Authorization": "Bearer " + token
  });
}

// ==================== PAYLOAD PARSING ====================

function extractPayload(req) {
  let raw = req.body;

  if (raw && typeof raw === "object" && raw.payload) {
    try { return JSON.parse(raw.payload); }
    catch(e) { console.error("SLACK-INTERACT: parse obj payload err:", e.message); return null; }
  }

  if (raw && typeof raw === "string") {
    try {
      const parsed = querystring.parse(raw);
      if (parsed.payload) return JSON.parse(parsed.payload);
    } catch(e) {}
    try { return JSON.parse(raw); } catch(e) {}
  }

  if (raw && typeof raw === "object" && raw.type) return raw;

  console.error("SLACK-INTERACT: Could not extract payload. Body type:", typeof raw);
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

// ==================== SLACK MESSAGE BLOCKS ====================

function buildSuccessBlocks(result, formData) {
  const amount = parseInt(String(formData.amount).replace(/[$,\s]/g, "")) || 0;
  const contractTypeLabel = formData.contract_type === "phase2" ? "Phase 2" : "Sprint 1";
  const signnowLink = result.document_id
    ? "https://app.signnow.com/webapp/document/" + result.document_id
    : null;

  const pipelineLines = [];

  if (result.document_id && signnowLink) {
    pipelineLines.push(`:white_check_mark: *Contract* generated — <${signnowLink}|View & Send Contract>`);
  } else if (result.document_id) {
    pipelineLines.push(`:white_check_mark: *Contract* generated and uploaded to SignNow`);
  } else {
    pipelineLines.push(`:x: *Contract* generation failed`);
  }

  if (result.stripe && !result.stripe.error && result.stripe.invoiceUrl) {
    pipelineLines.push(`:white_check_mark: *Stripe Invoice* created — <${result.stripe.invoiceUrl}|View Invoice>`);
  } else {
    pipelineLines.push(`:x: *Stripe Invoice* failed${result.stripe && result.stripe.error ? ": " + result.stripe.error : ""}`);
  }

  if (result.clickup && result.clickup.id) {
    pipelineLines.push(`:white_check_mark: *ClickUp Task* created — <${result.clickup.url}|View Task>`);
  } else {
    pipelineLines.push(`:x: *ClickUp Task* failed${result.clickup && result.clickup.error ? ": " + result.clickup.error : ""}`);
  }

  return [
    { type: "header", text: { type: "plain_text", text: "New Contract Created", emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Client:*\n${formData.client_first} ${formData.client_last}` },
        { type: "mrkdwn", text: `*Company:*\n${formData.client_company}` },
        { type: "mrkdwn", text: `*Type:*\n${contractTypeLabel}` },
        { type: "mrkdwn", text: `*Amount:*\n$${amount.toLocaleString()}` }
      ]
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Email:*\n${formData.client_email}` },
        { type: "mrkdwn", text: `*Title:*\n${formData.client_title}` }
      ]
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Pipeline Results:*" } },
    { type: "section", text: { type: "mrkdwn", text: pipelineLines.join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Scope: ${formData.scope || "N/A"}` }] }
  ];
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  console.log("SLACK-INTERACT: Handler invoked, method=" + req.method);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Extract the Slack payload
  const payload = extractPayload(req);
  if (!payload) {
    console.error("SLACK-INTERACT: No payload found");
    return res.status(200).send("");
  }

  console.log("SLACK-INTERACT: type=" + payload.type);

  if (payload.type !== "view_submission") {
    return res.status(200).send("");
  }

  if (!payload.view || payload.view.callback_id !== "new_contract_submit") {
    return res.status(200).send("");
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const userId = payload.user && payload.user.id;

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

  console.log("SLACK-INTERACT: formData company=" + formData.client_company + " email=" + formData.client_email);

  // CRITICAL: Respond 200 to Slack immediately (must be within 3 seconds)
  // The function continues executing after this (maxDuration: 60s in vercel.json)
  res.status(200).send("");

  // === BACKGROUND WORK (runs after response sent) ===

  try {
    // 1. Post "Processing..." message to channel
    if (token) {
      console.log("SLACK-INTERACT: Posting processing message to channel");
      const procMsg = await slackAPI("chat.postMessage", {
        channel: SLACK_CHANNEL,
        text: `:hourglass_flowing_sand: Generating contract for *${formData.client_company}*... This takes about 15 seconds.`
      }, token);
      console.log("SLACK-INTERACT: Processing msg ok=" + (procMsg.data && procMsg.data.ok));
    }

    // 2. Call the pipeline directly
    console.log("SLACK-INTERACT: Calling pipeline...");
    const pipelineResult = await postJSON(
      "aeo-contract-api.vercel.app",
      "/api/generate-and-send",
      formData,
      {}
    );

    console.log("SLACK-INTERACT: Pipeline status=" + pipelineResult.status);
    const result = pipelineResult.data || {};
    console.log("SLACK-INTERACT: Pipeline success=" + result.success);

    // 3. Post results to channel
    if (token) {
      if (result.success) {
        const blocks = buildSuccessBlocks(result, formData);
        const postResult = await slackAPI("chat.postMessage", {
          channel: SLACK_CHANNEL,
          text: "New contract created for " + formData.client_company,
          blocks: blocks
        }, token);
        console.log("SLACK-INTERACT: Posted results ok=" + (postResult.data && postResult.data.ok));
      } else {
        await slackAPI("chat.postMessage", {
          channel: SLACK_CHANNEL,
          text: `:warning: Contract pipeline error for *${formData.client_company}*: ${result.message || result.error || "Unknown error"}`
        }, token);
      }
    }

    // 4. DM the submitting user
    if (token && userId) {
      try {
        if (result.success) {
          await slackAPI("chat.postMessage", {
            channel: userId,
            text: `:white_check_mark: Contract for *${formData.client_company}* is ready! Check <#${SLACK_CHANNEL}> for all the links.`
          }, token);
        } else {
          await slackAPI("chat.postMessage", {
            channel: userId,
            text: `:x: Contract for *${formData.client_company}* had issues: ${result.message || result.error || "Unknown"}`
          }, token);
        }
      } catch(e) {
        console.log("SLACK-INTERACT: DM failed (non-critical):", e.message);
      }
    }

    console.log("SLACK-INTERACT: All done for " + formData.client_company);

  } catch(err) {
    console.error("SLACK-INTERACT: Error:", err.message);
    if (token) {
      try {
        await slackAPI("chat.postMessage", {
          channel: SLACK_CHANNEL,
          text: `:x: Contract pipeline crashed for *${formData.client_company || "unknown"}*: ${err.message}`
        }, token);
      } catch(e) {
        console.error("SLACK-INTERACT: Could not post error:", e.message);
      }
    }
  }
};
