export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { summary, description, ticketType, missionType, existingProject } = req.body;

  const email = process.env.JIRA_USER_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const credentials = Buffer.from(`${email}:${token}`).toString('base64');

  const label = ticketType === 'feasibility' ? 'feasibility-request' : 'new-mission-request';

  const payload = {
    fields: {
      project: { key: 'OP' },
      summary: summary,
      issuetype: { name: 'Story' },
      labels: [label],
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }]
          }
        ]
      }
    }
  };

  try {
    const response = await fetch('https://spexigeo.atlassian.net/rest/api/3/issue', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    return res.status(201).json({
      key: data.key,
      url: `https://spexigeo.atlassian.net/browse/${data.key}`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
