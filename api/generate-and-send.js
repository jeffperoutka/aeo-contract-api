/**
 * AEO Labs â Contract Generation & SignNow API
 *
 * Single serverless endpoint that:
 * 1. Receives contract data (from Zapier/Typeform webhook)
 * 2. Generates the .docx contract with Jeff's signature pre-embedded
 * 3. Uploads to SignNow
 * 4. Places CLIENT-ONLY signature fields
 * 5. Sends signing invite to client
 *
 * POST /api/generate-and-send
 * Body: {
 *   contract_type: "sprint1" | "phase2",
 *   client_company, client_first, client_last, client_title, client_email,
 *   amount, scope (phase2) | deliverable (sprint1),
 *   date (optional, defaults to today)
 * }
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, TabStopType, TabStopPosition,
  ImageRun,
} = require("docx");

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SIGNNOW CONFIG
const DISABLE_SIGNNOW_INVITE = true; // Set to false to re-enable
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const SN_CLIENT_ID     = process.env.SIGNNOW_CLIENT_ID     || "c3398b871ab67779ed1090ac1d34dfe1";
const SN_CLIENT_SECRET = process.env.SIGNNOW_CLIENT_SECRET || "0bde5c294ce791e9de91069f1c334682";
const SN_EMAIL         = process.env.SIGNNOW_EMAIL         || "Jeff@aeolabs.ai";
const SN_PASSWORD      = process.env.SIGNNOW_PASSWORD      || "JEFFpass123!";
const SN_BASE          = "api.signnow.com";
const JEFF_EMAIL       = "Jeff@aeolabs.ai";
const TYPEFORM_URL     = "https://form.typeform.com/to/pJ1KyOAF";

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SIGNNOW HELPERS
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function snRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: SN_BASE, port: 443, path: urlPath, method, headers: headers || {} };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function snMultipart(urlPath, token, fileBuffer, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = "----AEOBoundary" + Date.now();
    const mimeType = fileName.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, fileBuffer, tail]);

    const opts = {
      hostname: SN_BASE, port: 443, path: urlPath, method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function snAuthenticate() {
  const payload = `username=${encodeURIComponent(SN_EMAIL)}&password=${encodeURIComponent(SN_PASSWORD)}&grant_type=password&scope=*`;
  const auth = Buffer.from(`${SN_CLIENT_ID}:${SN_CLIENT_SECRET}`).toString("base64");
  const res = await snRequest("POST", "/oauth2/token", {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(payload),
  }, payload);
  if (!res.body.access_token) throw new Error("SignNow auth failed: " + JSON.stringify(res.body));
  return res.body.access_token;
}

async function snUpload(token, buffer, fileName) {
  const res = await snMultipart("/document", token, buffer, fileName);
  if (!res.body.id) throw new Error("SignNow upload failed: " + JSON.stringify(res.body));
  return res.body.id;
}

async function snGetDocInfo(token, docId) {
  const res = await snRequest("GET", `/document/${docId}`, {
    Authorization: `Bearer ${token}`,
  });
  return res.body;
}

async function snAddFields(token, docId, pageCount) {
  const lastPage = pageCount - 1;
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  const payload = JSON.stringify({
    fields: [
      {
        x: 55, y: 270, width: 220, height: 35,
        type: "signature", page_number: lastPage,
        required: true, role: "Client", label: "Signature",
      },
      {
        x: 55, y: 340, width: 180, height: 25,
        type: "text", page_number: lastPage,
        required: true, role: "Client", label: "Date",
        prefilled_text: dateStr,
      },
    ],
  });

  const res = await snRequest("PUT", `/document/${docId}`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  }, payload);

  if (res.body.errors) throw new Error("SignNow field error: " + JSON.stringify(res.body));
  return res;
}

async function snSendInvite(token, docId, signerEmail, signerName) {
  const payload = JSON.stringify({
    to: [{
      email: signerEmail,
      role: "Client",
      role_id: "",
      order: 1,
      reassign: "0",
      decline_by_signature: "0",
      reminder: 3,
      expiration_days: 30,
      subject: "AEO Labs â Contract Ready for Your Signature",
      message: `Hi ${signerName}, your contract with AEO Labs is ready for signature. Please review and sign at your convenience.`,
      redirect_uri: TYPEFORM_URL,
    }],
    from: JEFF_EMAIL,
    subject: "AEO Labs â Contract for Signature",
    message: "Please review and sign the attached contract.",
  });

  const res = await snRequest("POST", `/document/${docId}/invite`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  }, payload);

  if (res.body.errors) throw new Error("SignNow invite error: " + JSON.stringify(res.body));
  return res;
}

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CONTRACT GENERATION (embedded â same logic as generate_contract.js)
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const FONT = "Space Grotesk";
const BLACK = "000000";
const DARK_GRAY = "333333";
const MEDIUM_GRAY = "666666";
const LIGHT_GRAY = "999999";

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

function sectionTitle(number, title) {
  return new Paragraph({
    spacing: { before: 380, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: BLACK, space: 6 } },
    children: [
      new TextRun({ text: `Section ${number}:  `, bold: true, font: FONT, size: 22, color: BLACK }),
      new TextRun({ text: title, bold: true, font: FONT, size: 22, color: BLACK }),
    ],
  });
}

function bodyText(text) {
  return new Paragraph({
    spacing: { after: 160, line: 276 },
    children: [new TextRun({ text, font: FONT, size: 20, color: DARK_GRAY })],
  });
}

function boldBodyText(label, text) {
  return new Paragraph({
    spacing: { after: 140, line: 276 },
    children: [
      new TextRun({ text: label, bold: true, font: FONT, size: 20, color: BLACK }),
      new TextRun({ text, font: FONT, size: 20, color: DARK_GRAY }),
    ],
  });
}

function heading(text) {
  return new Paragraph({
    spacing: { before: 340, after: 140 },
    children: [new TextRun({ text, bold: true, font: FONT, size: 24, color: BLACK })],
  });
}

// Jeff's signature image â bundled as base64 for serverless (no filesystem dependency)
let JEFF_SIG_BUFFER = null;
try {
  // Try loading from file first (local dev)
  const sigPath = path.join(__dirname, "..", "assets", "jeff_signature.png");
  if (fs.existsSync(sigPath)) {
    JEFF_SIG_BUFFER = fs.readFileSync(sigPath);
  }
} catch {}

// Fallback: load from base64 env var (production)
if (!JEFF_SIG_BUFFER && process.env.JEFF_SIGNATURE_BASE64) {
  JEFF_SIG_BUFFER = Buffer.from(process.env.JEFF_SIGNATURE_BASE64, "base64");
}

function signatureBlock(name, title, company, prefilled, formattedDate) {
  const dateText = prefilled ? formattedDate : " ";

  const sigLineChildren = prefilled && JEFF_SIG_BUFFER
    ? [new ImageRun({
        data: JEFF_SIG_BUFFER,
        transformation: { width: 200, height: 58 },
        type: "png",
      })]
    : [new TextRun({ text: " ", font: FONT, size: 20, color: "FFFFFF" })];

  return [
    new Paragraph({ spacing: { before: 400 }, children: [] }),
    new Paragraph({
      spacing: { after: 8 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: BLACK, space: 1 } },
      children: sigLineChildren,
    }),
    new Paragraph({
      spacing: { after: 30 },
      children: [new TextRun({ text: "Signature", font: FONT, size: 17, color: MEDIUM_GRAY, italics: true })],
    }),
    new Paragraph({ spacing: { before: 200 }, children: [] }),
    new Paragraph({
      spacing: { after: 8 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: BLACK, space: 1 } },
      children: [new TextRun({ text: dateText, font: FONT, size: 20, color: prefilled ? DARK_GRAY : "FFFFFF" })],
    }),
    new Paragraph({
      spacing: { after: 30 },
      children: [new TextRun({ text: "Date", font: FONT, size: 17, color: MEDIUM_GRAY, italics: true })],
    }),
    new Paragraph({
      spacing: { before: 140, after: 30 },
      children: [new TextRun({ text: name, bold: true, font: FONT, size: 20, color: BLACK })],
    }),
    new Paragraph({
      spacing: { after: 30 },
      children: [new TextRun({ text: title, font: FONT, size: 20, color: MEDIUM_GRAY })],
    }),
    new Paragraph({
      spacing: { after: 30 },
      children: [new TextRun({ text: company, font: FONT, size: 20, color: MEDIUM_GRAY })],
    }),
  ];
}

function titlePage(subtitle, clientCompany, clientFirst, clientLast, clientTitle, formattedDate) {
  return [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 40 },
      children: [new TextRun({ text: "AEO LABS", bold: true, font: FONT, size: 60, color: BLACK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 80 },
      children: [new TextRun({ text: "LLC", bold: true, font: FONT, size: 26, color: MEDIUM_GRAY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLACK, space: 12 } },
      spacing: { after: 360 }, children: [],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: "MASTER SERVICES AGREEMENT", bold: true, font: FONT, size: 28, color: BLACK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: "&", font: FONT, size: 24, color: MEDIUM_GRAY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 260 },
      children: [new TextRun({ text: "STATEMENT OF WORK", bold: true, font: FONT, size: 28, color: BLACK })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 100 },
      children: [new TextRun({ text: subtitle, bold: true, font: FONT, size: 22, color: DARK_GRAY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 500 },
      children: [new TextRun({ text: formattedDate, font: FONT, size: 20, color: MEDIUM_GRAY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [
        new TextRun({ text: "Prepared for  ", font: FONT, size: 20, color: MEDIUM_GRAY }),
        new TextRun({ text: clientCompany, bold: true, font: FONT, size: 20, color: BLACK }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: `${clientFirst} ${clientLast}, ${clientTitle}`, font: FONT, size: 20, color: MEDIUM_GRAY })],
    }),
  ];
}

function partiesIntro(clientCompany, formattedDate) {
  return new Paragraph({
    spacing: { before: 200, after: 200, line: 276 },
    children: [
      new TextRun({ text: "This Master Services Agreement and Statement of Work (collectively, this \u201CAgreement\u201D) is entered into as of ", font: FONT, size: 20, color: DARK_GRAY }),
      new TextRun({ text: formattedDate, bold: true, font: FONT, size: 20, color: BLACK }),
      new TextRun({ text: " by and between ", font: FONT, size: 20, color: DARK_GRAY }),
      new TextRun({ text: "AEO Labs LLC", bold: true, font: FONT, size: 20, color: BLACK }),
      new TextRun({ text: " (\u201CService Provider\u201D) and ", font: FONT, size: 20, color: DARK_GRAY }),
      new TextRun({ text: clientCompany, bold: true, font: FONT, size: 20, color: BLACK }),
      new TextRun({ text: " (\u201CClient\u201D).", font: FONT, size: 20, color: DARK_GRAY }),
    ],
  });
}

function banner(text) {
  return new Paragraph({
    spacing: { before: 200, after: 240 }, alignment: AlignmentType.CENTER,
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 8 },
      top: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 8 },
    },
    children: [new TextRun({ text, bold: true, font: FONT, size: 24, color: BLACK })],
  });
}

function buildSprint1(data) {
  const { clientCompany, clientFirst, clientLast, clientTitle, formattedAmount, formattedDate, deliverable } = data;
  const clientName = `${clientFirst} ${clientLast}`;
  return [
    ...titlePage("Sprint 1 \u2014 60-Day Engagement", clientCompany, clientFirst, clientLast, clientTitle, formattedDate),
    new Paragraph({ children: [new PageBreak()] }),
    partiesIntro(clientCompany, formattedDate),
    banner("MASTER SERVICES AGREEMENT"),

    sectionTitle("1", "Services"),
    bodyText(`AEO Labs LLC (\u201CService Provider\u201D) agrees to provide Answer Engine Optimization services to ${clientCompany} (\u201CClient\u201D) as described in the Statement of Work attached hereto. Services shall not commence until full payment has been received by Service Provider.`),

    sectionTitle("2", "Term"),
    bodyText(`This Agreement shall commence on ${formattedDate} and shall continue for a period of sixty (60) calendar days (\u201CSprint Period\u201D), unless terminated earlier in accordance with Section 9.`),

    sectionTitle("3", "Payment Terms"),
    bodyText(`Client shall pay Service Provider the total fee of $${formattedAmount} USD upon execution of this Agreement. Payment is due prior to commencement of services. If payment is not received within seven (7) days of the Agreement date, Service Provider reserves the right to suspend all services until payment is received. All fees are non-refundable once work has commenced. Late payments shall accrue interest at a rate of 1.5% per month.`),

    sectionTitle("4", "Deliverable Acceptance"),
    bodyText("Upon delivery of any work product, Client shall have four (4) business days to review and provide written objection. If no written objection is received within this period, deliverables shall be deemed accepted. This acceptance timeline is critical to maintaining the Sprint schedule."),

    sectionTitle("5", "Intellectual Property"),
    bodyText("All work product created by Service Provider in the performance of this Agreement shall become the property of Client upon receipt of full payment. Until full payment is received, all intellectual property rights remain exclusively with Service Provider. Service Provider retains the right to use general knowledge, skills, and experience gained during the engagement, as well as any tools, frameworks, or methodologies that existed prior to or were developed independently of this Agreement."),

    sectionTitle("6", "Confidentiality"),
    bodyText("Each party agrees to maintain the confidentiality of any proprietary or confidential information disclosed by the other party during the term of this Agreement. This obligation shall survive termination for a period of two (2) years. Confidential information does not include information that: (a) is or becomes publicly available through no fault of the receiving party; (b) was known to the receiving party prior to disclosure; (c) is independently developed by the receiving party; or (d) is disclosed with the prior written consent of the disclosing party."),

    sectionTitle("7", "Non-Solicitation"),
    bodyText("During the term of this Agreement and for twelve (12) months following its termination, Client shall not directly or indirectly solicit, recruit, or hire any employee, contractor, or consultant of Service Provider who was involved in performing services under this Agreement."),

    sectionTitle("8", "Limitation of Liability"),
    bodyText("In no event shall either party be liable to the other for any indirect, incidental, special, consequential, or punitive damages, regardless of the cause of action or the theory of liability. Service Provider\u2019s total aggregate liability under this Agreement shall not exceed the total fees paid by Client under this Agreement."),

    sectionTitle("9", "Termination"),
    bodyText("Either party may terminate this Agreement with thirty (30) days written notice. In the event of termination, Client shall pay for all services rendered through the date of termination. All fees paid prior to termination are non-refundable once work has commenced. Service Provider may terminate this Agreement immediately if Client fails to make payment within seven (7) days of the due date."),

    sectionTitle("10", "Indemnification"),
    bodyText("Each party shall indemnify and hold harmless the other party from any third-party claims, damages, or expenses arising from the indemnifying party\u2019s breach of this Agreement or negligent acts."),

    sectionTitle("11", "Force Majeure"),
    bodyText("Neither party shall be liable for any failure or delay in performance under this Agreement due to circumstances beyond its reasonable control, including but not limited to acts of God, natural disasters, pandemic, government actions, war, terrorism, labor disputes, power failures, internet disruptions, or third-party service outages. The affected party shall provide prompt notice and use reasonable efforts to mitigate the impact."),

    sectionTitle("12", "Governing Law & Dispute Resolution"),
    bodyText("This Agreement shall be governed by and construed in accordance with the laws of the State of Wyoming. Any disputes arising under this Agreement shall be resolved through binding arbitration in the State of Wyoming, in accordance with the rules of the American Arbitration Association. The prevailing party shall be entitled to recover reasonable attorneys\u2019 fees and costs."),

    sectionTitle("13", "General Provisions"),
    bodyText("This Agreement constitutes the entire agreement between the parties and supersedes all prior negotiations, representations, or agreements relating to the subject matter hereof. This Agreement may not be amended except by written instrument signed by both parties. If any provision of this Agreement is held to be unenforceable, the remaining provisions shall remain in full force and effect."),

    new Paragraph({ children: [new PageBreak()] }),
    banner("STATEMENT OF WORK"),

    heading("Project Overview"),
    bodyText("Service Provider shall deliver a comprehensive Answer Engine Optimization sprint for Client, focused on improving Client\u2019s visibility and performance across AI-powered answer engines and search platforms."),

    heading("Deliverable"),
    bodyText(deliverable || "Comprehensive AEO audit, content strategy, and optimization implementation."),

    heading("Timeline"),
    bodyText("All deliverables shall be completed within sixty (60) calendar days from the date of payment receipt."),

    heading("Investment"),
    boldBodyText("Total Sprint Fee:  ", `$${formattedAmount} USD`),
    boldBodyText("Payment Terms:  ", "Due upon execution, prior to commencement of services."),
    bodyText("All fees are non-refundable once work has commenced."),

    new Paragraph({ children: [new PageBreak()] }),
    banner("SIGNATURES"),
    bodyText("IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above."),

    new Paragraph({
      spacing: { before: 400, after: 100 },
      children: [new TextRun({ text: "SERVICE PROVIDER", bold: true, font: FONT, size: 21, color: BLACK })],
    }),
    ...signatureBlock("Jeffrey Peroutka", "COO", "AEO Labs LLC", true, formattedDate),

    new Paragraph({
      spacing: { before: 400, after: 100 },
      children: [new TextRun({ text: "CLIENT", bold: true, font: FONT, size: 21, color: BLACK })],
    }),
    ...signatureBlock(clientName, clientTitle, clientCompany, false, formattedDate),
  ];
}

function buildPhase2(data) {
  const { clientCompany, clientFirst, clientLast, clientTitle, formattedAmount, formattedDate, scope } = data;
  const clientName = `${clientFirst} ${clientLast}`;
  return [
    ...titlePage("Phase 2 \u2014 Ongoing Monthly Retainer", clientCompany, clientFirst, clientLast, clientTitle, formattedDate),
    new Paragraph({ children: [new PageBreak()] }),
    partiesIntro(clientCompany, formattedDate),
    banner("MASTER SERVICES AGREEMENT"),

    sectionTitle("1", "Services"),
    bodyText(`AEO Labs LLC (\u201CService Provider\u201D) agrees to provide ongoing Answer Engine Optimization services to ${clientCompany} (\u201CClient\u201D) as described in the Statement of Work attached hereto. Services shall not commence until initial payment has been received by Service Provider.`),

    sectionTitle("2", "Term & Renewal"),
    bodyText(`This Agreement shall commence on ${formattedDate} and shall continue on a month-to-month basis, automatically renewing at the beginning of each billing period, unless terminated in accordance with Section 9. Each billing period begins on the first of the month following the commencement date.`),

    sectionTitle("3", "Payment Terms"),
    bodyText(`Client shall pay Service Provider a monthly retainer fee of $${formattedAmount} USD, due on the first of each month. The initial payment is due upon execution of this Agreement. If payment is not received within seven (7) days of the due date, Service Provider reserves the right to suspend all services until payment is received. Late payments shall accrue interest at a rate of 1.5% per month. Retainer fees may be adjusted by mutual written agreement between both parties.`),

    sectionTitle("4", "Deliverable Acceptance"),
    bodyText("Upon delivery of any work product, Client shall have four (4) business days to review and provide written objection. If no written objection is received within this period, deliverables shall be deemed accepted."),

    sectionTitle("5", "Intellectual Property"),
    bodyText("All work product created by Service Provider in the performance of this Agreement shall become the property of Client upon receipt of full payment for the applicable billing period. Until full payment is received, all intellectual property rights remain exclusively with Service Provider. Service Provider retains the right to use general knowledge, skills, and experience gained during the engagement, as well as any tools, frameworks, or methodologies that existed prior to or were developed independently of this Agreement."),

    sectionTitle("6", "Confidentiality"),
    bodyText("Each party agrees to maintain the confidentiality of any proprietary or confidential information disclosed by the other party during the term of this Agreement. This obligation shall survive termination for a period of two (2) years. Confidential information does not include information that: (a) is or becomes publicly available through no fault of the receiving party; (b) was known to the receiving party prior to disclosure; (c) is independently developed by the receiving party; or (d) is disclosed with the prior written consent of the disclosing party."),

    sectionTitle("7", "Non-Solicitation"),
    bodyText("During the term of this Agreement and for twelve (12) months following its termination, Client shall not directly or indirectly solicit, recruit, or hire any employee, contractor, or consultant of Service Provider who was involved in performing services under this Agreement."),

    sectionTitle("8", "Limitation of Liability"),
    bodyText("In no event shall either party be liable to the other for any indirect, incidental, special, consequential, or punitive damages, regardless of the cause of action or the theory of liability. Service Provider\u2019s total aggregate liability under this Agreement shall not exceed the total fees paid by Client in the three (3) months preceding the claim."),

    sectionTitle("9", "Termination"),
    bodyText("Either party may terminate this Agreement with thirty (30) days written notice, effective at the end of the current billing period. Failure to provide the required thirty (30) days written notice shall result in an early termination fee of $5,000 USD, payable immediately. Client shall pay for all services rendered through the effective date of termination. Service Provider may terminate this Agreement immediately if Client fails to make payment within seven (7) days of the due date."),

    sectionTitle("10", "Indemnification"),
    bodyText("Each party shall indemnify and hold harmless the other party from any third-party claims, damages, or expenses arising from the indemnifying party\u2019s breach of this Agreement or negligent acts."),

    sectionTitle("11", "Force Majeure"),
    bodyText("Neither party shall be liable for any failure or delay in performance under this Agreement due to circumstances beyond its reasonable control, including but not limited to acts of God, natural disasters, pandemic, government actions, war, terrorism, labor disputes, power failures, internet disruptions, or third-party service outages. The affected party shall provide prompt notice and use reasonable efforts to mitigate the impact."),

    sectionTitle("12", "Reporting"),
    bodyText("Service Provider shall deliver monthly performance reports to Client, summarizing work completed, key metrics, and recommendations for the upcoming period."),

    sectionTitle("13", "Governing Law & Dispute Resolution"),
    bodyText("This Agreement shall be governed by and construed in accordance with the laws of the State of Wyoming. Any disputes arising under this Agreement shall be resolved through binding arbitration in the State of Wyoming, in accordance with the rules of the American Arbitration Association. The prevailing party shall be entitled to recover reasonable attorneys\u2019 fees and costs."),

    sectionTitle("14", "General Provisions"),
    bodyText("This Agreement constitutes the entire agreement between the parties and supersedes all prior negotiations, representations, or agreements relating to the subject matter hereof. This Agreement may not be amended except by written instrument signed by both parties. If any provision of this Agreement is held to be unenforceable, the remaining provisions shall remain in full force and effect."),

    new Paragraph({ children: [new PageBreak()] }),
    banner("STATEMENT OF WORK"),

    heading("Project Overview"),
    bodyText("Service Provider shall deliver ongoing Answer Engine Optimization services for Client, including continuous strategy, optimization, and performance monitoring across AI-powered answer engines and search platforms."),

    heading("Scope of Services"),
    bodyText(scope || "As mutually agreed upon by both parties."),

    heading("Reporting"),
    bodyText("Monthly performance reports will be delivered summarizing work completed, key metrics, and strategic recommendations."),

    heading("Investment"),
    boldBodyText("Monthly Retainer:  ", `$${formattedAmount} USD`),
    boldBodyText("Payment Due:  ", "First of each month"),
    boldBodyText("Initial Payment:  ", "Due upon execution of this Agreement"),

    new Paragraph({ children: [new PageBreak()] }),
    banner("SIGNATURES"),
    bodyText("IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above."),

    new Paragraph({
      spacing: { before: 400, after: 100 },
      children: [new TextRun({ text: "SERVICE PROVIDER", bold: true, font: FONT, size: 21, color: BLACK })],
    }),
    ...signatureBlock("Jeffrey Peroutka", "COO", "AEO Labs LLC", true, formattedDate),

    new Paragraph({
      spacing: { before: 400, after: 100 },
      children: [new TextRun({ text: "CLIENT", bold: true, font: FONT, size: 21, color: BLACK })],
    }),
    ...signatureBlock(clientName, clientTitle, clientCompany, false, formattedDate),
  ];
}

async function generateContract(data) {
  const children = data.contractType === "phase2" ? buildPhase2(data) : buildSprint1(data);

  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT, size: 20 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({ text: "AEO Labs LLC", font: FONT, size: 15, color: LIGHT_GRAY, italics: true }),
                new TextRun({ text: "  |  ", font: FONT, size: 15, color: LIGHT_GRAY }),
                new TextRun({ text: "Confidential", font: FONT, size: 15, color: LIGHT_GRAY, italics: true }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "Page ", font: FONT, size: 15, color: LIGHT_GRAY }),
                new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 15, color: LIGHT_GRAY }),
              ],
            }),
          ],
        }),
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// API HANDLER
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ



// ==================== STRIPE INTEGRATION ====================
function stripeRequest(method, path, formData) {
  return new Promise((resolve, reject) => {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return reject(new Error("STRIPE_SECRET_KEY not set"));
    const encoded = Buffer.from(formData).toString();
    const options = {
      hostname: "api.stripe.com",
      port: 443,
      path: "/v1" + path,
      method: method,
      headers: {
        "Authorization": "Basic " + Buffer.from(stripeKey + ":").toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formData)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Stripe parse error: " + data.substring(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(formData);
    req.end();
  });
}

async function createStripeInvoice(clientEmail, clientName, clientCompany, amountCents, description) {
  console.log("STRIPE: Creating customer for " + clientEmail);
  // Create or find customer
  const customer = await stripeRequest("POST", "/customers", 
    "email=" + encodeURIComponent(clientEmail) + "&name=" + encodeURIComponent(clientName) + "&metadata[company]=" + encodeURIComponent(clientCompany)
  );
  console.log("STRIPE: Customer created: " + customer.id);
  
  // Create invoice
  console.log("STRIPE: Creating invoice for " + amountCents + " cents");
  const invoice = await stripeRequest("POST", "/invoices",
    "customer=" + customer.id + "&collection_method=send_invoice&days_until_due=30&auto_advance=true"
  );
  console.log("STRIPE: Invoice created: " + invoice.id);
  
  // Add invoice item
  await stripeRequest("POST", "/invoiceitems",
    "customer=" + customer.id + "&invoice=" + invoice.id + "&amount=" + amountCents + "&currency=usd&description=" + encodeURIComponent(description)
  );
  console.log("STRIPE: Invoice item added");
  
  // Finalize invoice
  const finalized = await stripeRequest("POST", "/invoices/" + invoice.id + "/finalize", "");
  console.log("STRIPE: Invoice finalized, status: " + finalized.status);
  
  return { customerId: customer.id, invoiceId: invoice.id, invoiceUrl: finalized.hosted_invoice_url, invoicePdf: finalized.invoice_pdf };
}

// ==================== CLICKUP INTEGRATION ====================
function clickupRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.CLICKUP_API_TOKEN;
    if (!token) return reject(new Error("CLICKUP_API_TOKEN not set"));
    console.log("CLICKUP: Token prefix: " + (token ? token.substring(0, 5) + "..." : "EMPTY"));
    const bodyStr = body ? JSON.stringify(body) : "";
    const options = {
      hostname: "api.clickup.com",
      port: 443,
      path: "/api/v2" + path,
      method: method,
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      }
    };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("ClickUp parse error: " + data.substring(0, 200))); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function createClickUpTask(clientCompany, contractType, amount, clientEmail, signNowDocId, stripeInvoiceUrl) {
  // Post to the AEO Labs contracts list
  // List ID for contract tasks - using AEO Labs workspace
  const listId = process.env.CLICKUP_LIST_ID || "901307458702";
  console.log("CLICKUP: Creating task in list " + listId);
  const task = await clickupRequest("POST", "/list/" + listId + "/task", {
    name: "Contract: " + clientCompany + " - " + contractType.toUpperCase(),
    description: "New contract generated and sent for signature.\n\n" +
      "Client: " + clientCompany + "\n" +
      "Email: " + clientEmail + "\n" +
      "Type: " + contractType + "\n" +
      "Amount: $" + (parseInt(amount) || 0).toLocaleString() + "\n" +
      "SignNow Doc ID: " + (signNowDocId || "N/A") + "\n" +
      "Invoice: " + (stripeInvoiceUrl || "N/A"),
    status: "to do",
    priority: 2,
    tags: ["contract", "auto-generated"]
  });
  console.log("CLICKUP: Task response: " + JSON.stringify(task).substring(0, 500));
  return task;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Simple API key check (optional, set via env var)
  const apiKey = process.env.API_KEY;
  if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body;

    // Validate required fields
    const required = ["contract_type", "client_company", "client_first", "client_last", "client_title", "client_email", "amount"];
    for (const field of required) {
      if (!body[field]) {
        console.log('[SKIP] Incomplete submission, missing:', field); return res.status(200).json({ skipped: true, message: 'Incomplete submission - missing field: ' + field });
      }
    }

    const contractType = body.contract_type === "Phase 2" ? "phase2" : "sprint1";
    const amount = String(body.amount).replace(/[,$]/g, "");
    const contractDate = body.date || new Date().toISOString().split("T")[0];
    const dateObj = new Date(contractDate + "T12:00:00");
    const formattedDate = dateObj.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const formattedAmount = Number(amount).toLocaleString("en-US");

    const data = {
      contractType,
      clientCompany: body.client_company,
      clientFirst: body.client_first,
      clientLast: body.client_last,
      clientTitle: body.client_title,
      formattedAmount,
      formattedDate,
      deliverable: body.deliverable || body.scope || "",
      scope: body.scope || body.deliverable || "",
    };

    const clientName = `${body.client_first} ${body.client_last}`;
    const fileName = `${contractType === "phase2" ? "Phase2" : "Sprint1"}_${body.client_company.replace(/[^a-zA-Z0-9]/g, "")}_MSA_SOW.docx`;

    console.log(`Generating ${contractType} contract for ${clientName} at ${body.client_company}...`);

    // Step 1: Generate the .docx
    const docxBuffer = await generateContract(data);
    console.log(`Contract generated: ${fileName} (${docxBuffer.length} bytes)`);

    // Step 2: Authenticate with SignNow
    const token = await snAuthenticate();
    console.log("SignNow authenticated");

    // Step 3: Upload to SignNow
    const docId = await snUpload(token, docxBuffer, fileName);
    console.log(`Uploaded to SignNow: ${docId}`);

    // Step 4: Get doc info for page count
    const docInfo = await snGetDocInfo(token, docId);
    const pageCount = docInfo.page_count || (docInfo.pages ? docInfo.pages.length : 1);
    console.log(`Document has ${pageCount} pages`);

    // Step 5: Add CLIENT-ONLY fields
    await snAddFields(token, docId, pageCount);
    console.log("Client signature fields added");

    // Step 6: Send invite
    if (DISABLE_SIGNNOW_INVITE) {
      console.log("[SIGNNOW] Invite sending DISABLED");
    } else {
      await snSendInvite(token, docId, body.client_email, clientName);
    }
    console.log(`Invite sent to ${clientName} (${body.client_email})`);


    // ==================== STRIPE INVOICE ====================
    let stripeResult = null;
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      stripeResult = await createStripeInvoice(
        body.client_email, clientName, body.client_company,
        amountCents, contractType === "sprint1" ? "AI Visibility Sprint" : "Phase 2 Retainer - " + (body.scope || body.deliverable || "")
      );
      console.log("STRIPE: Success - Invoice URL: " + stripeResult.invoiceUrl);
    } catch (stripeErr) {
      console.error("STRIPE ERROR: " + stripeErr.message);
      stripeResult = { error: stripeErr.message };
    }

    // ==================== CLICKUP NOTIFICATION ====================
    let clickupResult = null;
    try {
      clickupResult = await createClickUpTask(
        body.client_company, contractType, amount, body.client_email,
        docId, stripeResult && stripeResult.invoiceUrl ? stripeResult.invoiceUrl : null
      );
      // Check if ClickUp API returned an error in the response body (e.g. {err: "...", ECODE: "..."})
      if (clickupResult && (clickupResult.err || clickupResult.error)) {
        const errMsg = clickupResult.err || clickupResult.error;
        console.error("CLICKUP API ERROR: " + errMsg + (clickupResult.ECODE ? " (ECODE: " + clickupResult.ECODE + ")" : ""));
        clickupResult = { error: errMsg, ECODE: clickupResult.ECODE || null };
      } else {
        console.log("CLICKUP: Success - Task ID: " + (clickupResult.id || "unknown"));
      }
    } catch (clickupErr) {
      console.error("CLICKUP ERROR: " + clickupErr.message);
      clickupResult = { error: clickupErr.message };
    }

    const clickupOk = clickupResult && !clickupResult.error && !clickupResult.err;
    return res.status(200).json({
      success: true,
      message: "Contract generated, uploaded to SignNow" + (stripeResult && !stripeResult.error ? ", Stripe invoice created" : "") + (clickupOk ? ", ClickUp task created" : ""),
      document_id: docId,
      contract_type: contractType,
      client: clientName,
      company: body.client_company,
      amount: formattedAmount,
      stripe: stripeResult || { skipped: true },
      clickup: clickupOk ? { id: clickupResult.id, url: clickupResult.url } : (clickupResult && clickupResult.error ? { error: clickupResult.error, ECODE: clickupResult.ECODE } : { skipped: true })
    });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};
