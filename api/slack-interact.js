/**
 * AEO Labs — Slack Interaction Handler
 *
 * Receives modal form submissions from the /new-contract slash command.
 * Extracts field values, calls the pipeline directly, and posts results to Slack.
 *
 * Slack sends interactions as application/x-www-form-urlencoded with a
 * "payload" field containing JSON. This handler parses that correctly.
 *
 * POST /api/slack-interact
 */

const https = require("https");
const querystring = require("querystring");

// Slack channel for posting results
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || "C0AHK69NL8K"; // #contracts-invoices

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
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.substring(0, 1000) }); }
      });
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

  // Each block_id contains an action_id "value" with the user input
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

function buildSuccessBlocks(result, formData, signnowLink) {
  const amount = parseInt(String(formData.amount).replace(/[$,\s]/g, "")) || 0;
  const contractTypeLabel = formData.contract_type === "phase2" ? "Phase 2" : "Sprint 1";

  const pipelineLines = [];

  // Contract line - with link if available
  if (result.document_id) {
    if (signnowLink) {
      pipelineLines.push(`:white_check_mark: *Contract* generated — <${signnowLink}|View & Send Contract>`);
    } else {
      pipelineLines.push(`:white_check_mark: *Contract* generated and uploaded to SignNow`);
    }
  } else {
    pipelineLines.push(`:x: *Contract* generation failed`);
  }

  // Stripe line
  if (result.stripe && !result.stripe.error && result.stripe.invoiceUrl) {
    pipelineLines.push(`:white_check_mark: *Stripe Invoice* created — <${result.stripe.invoiceUrl}|View Invoice>`);
  } else if (result.stripe && result.stripe.error) {
    pipelineLines.push(`:x: *Stripe Invoice* failed: ${result.stripe.error}`);
  } else {
    pipelineLines.push(`:x: *Stripe Invoice* failed`);
  }

  // ClickUp line
  if (result.clickup && result.clickup.id) {
    pipelineLines.push(`:white_check_mark: *ClickUp Task* created — <${result.clickup.url}|View Task>`);
  } else if (result.clickup && result.clickup.error) {
    pipelineLines.push(`:x: *ClickUp Task* failed: ${result.clickup.error}`);
  } else {
    pipelineLines.push(`:x: *ClickUp Task* failed`);
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "New Contract Created", emoji: true }
    },
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
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Pipeline Results:*" }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: pipelineLines.join("\n") }
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Scope: ${formData.scope || "N/A"}` }
      ]
    }
  ];
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  console.log("SLACK-INTERACT: Received request");
  console.log("SLACK-INTERACT: Method=" + req.method);
  console.log("SLACK-INTERACT: Content-Type=" + (req.headers["content-type"] || "none"));
  console.log("SLACK-INTERACT: Body type=" + typeof req.body);
  console.log("SLACK-INTERACT: Body keys=" + (req.body && typeof req.body === "object" ? Object.keys(req.body).join(",") : "N/A"));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CRITICAL: Respond to Slack immediately (within 3 seconds)
  // We MUST send 200 before doing any pipeline work
  res.status(200).send("");

  // Now process asynchronously after responding
  try {
    const payload = extractPayload(req);
    if (!payload) {
      console.error("SLACK-INTERACT: Could not extract payload, aborting");
      return;
    }

    console.log("SLACK-INTERACT: Payload type=" + payload.type);

    // Only handle view_submission for our contract modal
    if (payload.type !== "view_submission") {
      console.log("SLACK-INTERACT: Ignoring type:", payload.type);
      return;
    }

    if (!payload.view || payload.view.callback_id !== "new_contract_submit") {
      console.log("SLACK-INTERACT: Ignoring callback_id:", payload.view && payload.view.callback_id);
      return;
    }

    const token = process.env.SLACK_BOT_TOKEN;
    const userId = payload.user && payload.user.id;
    const userName = payload.user && (payload.user.name || payload.user.username);

    console.log("SLACK-INTERACT: Processing form from user=" + userName + " id=" + userId);

    // Extract form values
    const formValues = extractFormValues(payload.view.state);
    console.log("SLACK-INTERACT: Form values:", JSON.stringify(formValues));

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

    console.log("SLACK-INTERACT: Normalized data:", JSON.stringify({
      type: formData.contract_type,
      company: formData.client_company,
      email: formData.client_email,
      amount: formData.amount
    }));

    // Send a "processing" DM to the user
    if (token && userId) {
      try {
        await slackAPI("chat.postMessage", {
          channel: userId,
          text: `:hourglass_flowing_sand: Generating contract for *${formData.client_company}*... This takes about 10 seconds. Results will appear in <#${SLACK_CHANNEL}>.`
        }, token);
      } catch(e) {
        console.log("SLACK-INTERACT: Could not DM user (non-critical):", e.message);
      }
    }

    // Call the main pipeline directly
    console.log("SLACK-INTERACT: Calling pipeline...");
    const pipelineResult = await postJSON(
      "aeo-contract-api.vercel.app",
      "/api/generate-and-send",
      formData,
      {}
    );

    console.log("SLACK-INTERACT: Pipeline HTTP status=" + pipelineResult.status);
    const result = pipelineResult.data || {};
    console.log("SLACK-INTERACT: Pipeline success=" + result.success);

    // Build the SignNow link from the document_id
    const signnowLink = result.document_id
      ? "https://app.signnow.com/webapp/document/" + result.document_id
      : null;

    // Post results to #contracts-invoices
    if (token) {
      try {
        if (result.success) {
          const blocks = buildSuccessBlocks(result, formData, signnowLink);
          const slackResult = await slackAPI("chat.postMessage", {
            channel: SLACK_CHANNEL,
            text: "New contract created for " + formData.client_company,
            blocks: blocks
          }, token);
          console.log("SLACK-INTERACT: Posted to channel, ok=" + (slackResult.data && slackResult.data.ok));
        } else {
          await slackAPI("chat.postMessage", {
            channel: SLACK_CHANNEL,
            text: `:warning: Contract pipeline error for *${formData.client_company}*: ${result.message || result.error || "Unknown error"}`
          }, token);
        }
      } catch(e) {
        console.error("SLACK-INTERACT: Failed to post to channel:", e.message);
      }

      // Send completion DM
      if (userId) {
        try {
          if (result.success) {
            await slackAPI("chat.postMessage", {
              channel: userId,
              text: `:white_check_mark: Contract for *${formData.client_company}* is ready! Check <#${SLACK_CHANNEL}> for all the links.`
            }, token);
          } else {
            await slackAPI("chat.postMessage", {
              channel: userId,
              text: `:x: Contract for *${formData.client_company}* had issues: ${result.message || result.error || "Unknown error"}`
            }, token);
          }
        } catch(e) {
          console.log("SLACK-INTERACT: Could not send completion DM (non-critical):", e.message);
        }
      }
    } else {
      console.error("SLACK-INTERACT: No SLACK_BOT_TOKEN, cannot post results");
    }

  } catch(err) {
    console.error("SLACK-INTERACT: Unhandled error:", err.message, err.stack);
    // Try to notify user of the error
    try {
      const token = process.env.SLACK_BOT_TOKEN;
      if (token) {
        await slackAPI("chat.postMessage", {
          channel: SLACK_CHANNEL,
          text: `:x: Contract pipeline crashed: ${err.message}`
        }, token);
      }
    } catch(e) {
      console.error("SLACK-INTERACT: Could not even post error message:", e.message);
    }
  }
};
