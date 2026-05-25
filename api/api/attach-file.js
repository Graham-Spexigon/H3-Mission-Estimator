export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { issueKey, filename, mimeType, data } = req.body;

  if (!issueKey || !filename || !data) {
    return res.status(400).json({ error: 'Missing required fields: issueKey, filename, data' });
  }

  const email = process.env.JIRA_USER_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const credentials = Buffer.from(`${email}:${token}`).toString('base64');

  // Reconstruct file from base64 and build multipart form
  const buffer = Buffer.from(data, 'base64');
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  const form = new FormData();
  form.append('file', blob, filename);

  try {
    const response = await fetch(
      `https://spexigeo.atlassian.net/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'X-Atlassian-Token': 'no-check',
          Accept: 'application/json',
          // Do NOT set Content-Type — fetch sets it automatically with the multipart boundary
        },
        body: form,
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      const msg = result?.errors
        ? Object.values(result.errors).join(', ')
        : result?.errorMessages?.join(', ') || `JIRA error ${response.status}`;
      return res.status(response.status).json({ error: msg });
    }

    return res.status(200).json({ ok: true, filename });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
