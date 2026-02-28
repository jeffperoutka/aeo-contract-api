/**
 * AEO Labs — Slack Interaction Handler
 *
 * Receives form submissions from the /new-contract modal.
 * Extracts field values, calls the main pipeline via /api/slack-contract,
 * and lets that endpoint handle Slack notifications.
 *
 * POST /api/slack-interact
 */

const https = require("https");

function postJSON(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers
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
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "slack.com",
      port: 443,
      path: "/api/" + method,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false, error: "parse_error" }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = async (req, res) => {
  console.log("SLACK-INTERACT: Received interaction");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Slack sends interactions as application/x-www-form-urlencoded with a "payload" field
  let payload;
  try {
    const rawPayload = req.body.payload || req.body;
    payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch (e) {
    console.error("SLACK-INTERACT: Failed to parse payload:", e.message);
    return res.status(200).json({ response_action: "errors", errors: { scope: "Failed to parse form data" } });
  }

  console.log("SLACK-INTERACT: type=" + payload.type + " callback_id=" + (payload.view && payload.view.callback_id));

  // Only handle view_submission for our modal
  if (payload.type !== "view_submission" || !payload.view || payload.view.callback_id !== "new_contract_submit") {
    console.log("SLACK-INTERACT: Ignoring non-matching interaction type:", payload.type);
    return res.status(200).send("");
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const userId = payload.user && payload.user.id;
  const userName = payload.user && payload.user.name;

  // Extract values from the modal form
  const values = payload.view.state.values;

  const contractType = values.contract_type && values.contract_type.value
    ? values.contract_type.value.selected_option.value
    : "";
  const clientCompany = values.client_company && values.client_company.value
    ? values.client_company.value.value
    : "";
  const clientFirst = values.client_first && values.client_first.value
    ? values.client_first.value.value
    : "";
  const clientLast = values.client_last && values.client_last.value
    ? values.client_last.value.value
    : "";
  const clientTitle = values.client_title && values.client_title.value
    ? values.client_title.value.value
    : "";
  const clientEmail = values.client_email && values.client_email.value
    ? values.client_email.value.value
    : "";
  const amount = values.amount && values.amount.value
    ? values.amount.value.value
    : "";
  const scope = values.scope && values.scope.value
    ? values.scope.value.value
    : "";

  console.log("SLACK-INTERACT: Extracted - company=" + clientCompany + " email=" + clientEmail + " amount=" + amount + " type=" + contractType);

  // Validate email format before submitting
  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail.trim())) {
    return res.status(200).json({
      response_action: "errors",
      errors: {
        client_email: "Please enter a valid email address"
      }
    });
  }

  // Validate amount is numeric
  const cleanAmount = String(amount).replace(/[$,\s]/g, "");
  if (!cleanAmount || isNaN(cleanAmount) || parseFloat(cleanAmount) <= 0) {
    return res.status(200).json({
      response_action: "errors",
      errors: {
        amount: "Please enter a valid dollar amount (e.g. 5000)"
      }
    });
  }

  // Close the modal immediately (respond within 3 seconds)
  // We'll process in the background and post results to the channel
  res.status(200).send("");

  // Now call the pipeline (this happens after we've already responded)
  try {
    // Send a "processing" message to the user via DM
    if (token && userId) {
      await slackAPI("chat.postMessage", {
        channel: userId,
        text: ":hourglass_flowing_sand: Generating contract for *" + clientCompany + "*... This takes about 10 seconds. Results will be posted to #contracts-invoices."
      }, token);
    }

    // Call our slack-contract endpoint which handles the pipeline + Slack notification
    const pipelineBody = {
      contract_type: contractType === "sprint1" ? "Sprint 1" : "Phase 2",
      client_company: clientCompany,
      client_first: clientFirst,
      client_last: clientLast,
      client_title: clientTitle,
      client_email: clientEmail,
      amount: amount,
      scope: scope
    };

    console.log("SLACK-INTERACT: Calling pipeline...");

    const result = await postJSON(
      "aeo-contract-api.vercel.app",
      "/api/slack-contract",
      pipelineBody,
      {}
    );

    console.log("SLACK-INTERACT: Pipeline result status=" + result.status + " success=" + (result.data && result.data.success));

    // Send a DM confirmation
    if (token && userId) {
      if (result.data && result.data.success) {
        await slackAPI("chat.postMessage", {
          channel: userId,
          text: ":white_check_mark: Contract for *" + clientCompany + "* generated successfully! Check #contracts-invoices for details."
        }, token);
      } else {
        const errMsg = result.data && (result.data.error || result.data.message) || "Unknown error";
        await slackAPI("chat.postMessage", {
          channel: userId,
          text: ":x: Contract generation for *" + clientCompany + "* had issues: " + errMsg
        }, token);
      }
    }

  } catch (err) {
    console.error("SLACK-INTERACT: Pipeline error:", err.message);
    if (token && userId) {
      await slackAPI("chat.postMessage", {
        channel: userId,
        text: ":x: Contract generation failed: " + err.message
      }, token);
    }
  }
};
