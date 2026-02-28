const https = require("https");

module.exports = (req, res) => {
  const token = process.env.CLICKUP_API_TOKEN;

  if (!token) {
    return res.status(200).json({
      error: "CLICKUP_API_TOKEN not set",
      tokenExists: false
    });
  }

  // Show token info (safe prefix only)
  const tokenInfo = {
    prefix: token.substring(0, 8) + "...",
    length: token.length,
    hasWhitespace: token !== token.trim(),
    hasNewlines: token.includes("\n") || token.includes("\r"),
    startsWithPk: token.startsWith("pk_")
  };

  // Test the token against ClickUp API - just get authorized user
  const options = {
    hostname: "api.clickup.com",
    port: 443,
    path: "/api/v2/user",
    method: "GET",
    headers: {
      "Authorization": token,
      "Content-Type": "application/json"
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = "";
    apiRes.on("data", (chunk) => data += chunk);
    apiRes.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        res.status(200).json({
          tokenInfo: tokenInfo,
          httpStatus: apiRes.statusCode,
          clickupResponse: parsed
        });
      } catch(e) {
        res.status(200).json({
          tokenInfo: tokenInfo,
          httpStatus: apiRes.statusCode,
          rawResponse: data.substring(0, 500)
        });
      }
    });
  });

  apiReq.on("error", (err) => {
    res.status(200).json({
      tokenInfo: tokenInfo,
      error: err.message
    });
  });

  apiReq.end();
};
