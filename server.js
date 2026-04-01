require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  const publicPaths = ["/", "/health", "/test-search"];

  if (publicPaths.includes(req.path)) {
    return next();
  }

  const key = req.headers["x-api-key"];
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

let tokenCache = null;
let instanceUrl = null;

async function getToken() {
  if (tokenCache) return tokenCache;

  const params = new URLSearchParams();
  params.append("grant_type", "password");
  params.append("client_id", process.env.SF_CLIENT_ID);
  params.append("client_secret", process.env.SF_CLIENT_SECRET);
  params.append("username", process.env.SF_USERNAME);
  params.append(
    "password",
    process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
  );

  const res = await axios.post(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  tokenCache = res.data.access_token;
  instanceUrl = res.data.instance_url;

  return tokenCache;
}

async function querySF(soql) {
  const token = await getToken();

  const res = await axios.get(
    `${instanceUrl}/services/data/${process.env.SF_API_VERSION}/query`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: soql }
    }
  );

  return res.data.records;
}

function clean(text) {
  if (!text) return "";
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "salesforce-middleware" });
});

app.get("/cases/search", async (req, res) => {
  try {
    const { caseNumber, keyword } = req.query;

    if (!caseNumber && !keyword) {
      return res.status(400).json({ error: "Provide caseNumber or keyword" });
    }

    let soql = `
      SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate
      FROM Case
    `;

    if (caseNumber) {
      soql += ` WHERE CaseNumber = '${caseNumber}'`;
    } else {
      soql += ` WHERE Subject LIKE '%${keyword}%'`;
    }

    soql += " ORDER BY CreatedDate DESC LIMIT 5";

    const records = await querySF(soql);

    res.json({
      cases: records.map(c => ({
        id: c.Id,
        caseNumber: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        createdDate: c.CreatedDate
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/cases/:id/context", async (req, res) => {
  try {
    const caseId = req.params.id;

    const caseQ = `
      SELECT Id, CaseNumber, Subject, Status, Priority, Description, CreatedDate
      FROM Case WHERE Id='${caseId}' LIMIT 1
    `;

    const emailQ = `
      SELECT Id, FromAddress, ToAddress, Subject, TextBody, MessageDate
      FROM EmailMessage
      WHERE ParentId='${caseId}'
      ORDER BY MessageDate DESC LIMIT 20
    `;

    const commentQ = `
      SELECT Id, CommentBody, CreatedDate, CreatedBy.Name
      FROM CaseComment
      WHERE ParentId='${caseId}'
      ORDER BY CreatedDate DESC LIMIT 20
    `;

    const feedQ = `
      SELECT Id, Body, Type, CreatedDate, CreatedBy.Name
      FROM FeedItem
      WHERE ParentId='${caseId}'
      ORDER BY CreatedDate DESC LIMIT 20
    `;

    const [caseData, emails, comments, feed] = await Promise.all([
      querySF(caseQ),
      querySF(emailQ),
      querySF(commentQ),
      querySF(feedQ)
    ]);

    const caseObj = caseData[0];

    const cleanEmails = emails.map(e => ({
      id: e.Id,
      direction: "incoming",
      from: e.FromAddress,
      to: [e.ToAddress],
      subject: e.Subject,
      text: clean(e.TextBody),
      date: e.MessageDate
    }));

    const cleanComments = comments.map(c => ({
      id: c.Id,
      author: c.CreatedBy?.Name,
      body: clean(c.CommentBody),
      date: c.CreatedDate
    }));

    const cleanFeed = feed.map(f => ({
      id: f.Id,
      type: f.Type,
      author: f.CreatedBy?.Name,
      body: clean(f.Body),
      date: f.CreatedDate
    }));

    const timeline = [
      ...cleanEmails.map(e => ({
        source: "email",
        date: e.date,
        author: e.from,
        summary: e.text.slice(0, 120)
      })),
      ...cleanComments.map(c => ({
        source: "comment",
        date: c.date,
        author: c.author,
        summary: c.body.slice(0, 120)
      })),
      ...cleanFeed.map(f => ({
        source: "feed",
        date: f.date,
        author: f.author,
        summary: f.body.slice(0, 120)
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      case: caseObj,
      emails: cleanEmails,
      comments: cleanComments,
      feed: cleanFeed,
      files: [],
      timeline,
      summarySeed: {
        latestCustomerMessage: cleanEmails[0]?.text || "",
        lastInternalAction: cleanFeed[0]?.body || "",
        currentBlocker: "unknown",
        missingInfo: []
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/test-search", async (req, res) => {
  try {
    const { caseNumber } = req.query;

    if (!caseNumber) {
      return res.status(400).json({ error: "Provide caseNumber" });
    }

    const soql = `
      SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate
      FROM Case
      WHERE CaseNumber = '${caseNumber}'
      ORDER BY CreatedDate DESC
      LIMIT 5
    `;

    const records = await querySF(soql);

    res.json({
      cases: records.map(c => ({
        id: c.Id,
        caseNumber: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        createdDate: c.CreatedDate
      }))
    });
  } catch (e) {
  res.status(500).json({
    error: e.message,
    details: e.response?.data || null
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
