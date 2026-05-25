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

  const fileBuffer = Buffer.from(data, 'base64');
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const nl = '\r\n';
  const contentType = mimeType || 'application/octet-stream';

  // Build multipart body using plain Buffers — no Blob/FormData needed
  const header = Buffer.from(
    `--${boundary}${nl}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${nl}` +
    `Content-Type: ${contentType}${nl}` +
    `${nl}`,
    'utf8'
  );
  const footer = Buffer.from(`${nl}--${boundary}--${nl}`, 'utf8');
  const body = Buffer.concat([header, fileBuffer, footer]);

  try {
    const response = await fetch(
      `https://spexigeo.atlassian.net/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'X-Atlassian-Token': 'no-check',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Accept': 'application/json',
        },
        body,
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
