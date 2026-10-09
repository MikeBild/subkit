import { translate } from "../../apps/cockpit/src/lib/i18n.ts";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyKnowledgeWriteEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  const t = (key) => translate(locale, key);
  const sourcePath = `/v1/knowledge-sources/${recordId}`;
  const filePath = `/v1/files/${recordId}`;
  const initial = "# Handbook\n\nContact the support desk.";
  const revised = "# Handbook\n\nContact the on-call operator.";
  const note = "Clarified escalation ownership.";
  const newName = "replacement-instructions.md";
  const fileText = "# Replacement instructions\n\nUse the revised process.";
  const path = "handbook.md";
  let text = initial;
  let filename = "report-notes.md";
  let fileContent = "# Report notes\n\nValidated input.";
  let version = 1;
  let savedNote = null;
  let savedFile = null;
  let replacement = null;
  const events = [];
  const versionToken = () => (version === 1 ? "a" : "b").repeat(64);
  const history = () => ({
    version,
    content_hash: versionToken(),
    note: savedNote,
    author: { kind: "user", id: recordId },
    current: true,
    created_at: "2025-07-11T12:00:00.000Z",
  });
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === `${sourcePath}/content`) {
      if (method === "PUT") {
        const body = request.postDataJSON();
        require(Object.keys(body).sort().join() ===
          "content,expected_version,note,path", "Content PUT contract drift");
        require(body.expected_version === versionToken() &&
          body.path === path, "Must send loaded CAS token and document path");
        require(body.content === revised &&
          body.note === note, "Must persist exact revised text and trimmed note");
        require(version === 1, "Only one content write allowed");
        text = body.content;
        savedNote = body.note;
        version = 2;
        events.push("content-put");
      } else require(method === "GET", "Unexpected content mutation");
      events.push(`content-${method}-${version}`);
      return route.fulfill({
        json: {
          knowledge_source_id: recordId,
          version: versionToken(),
          editable: true,
          documents: [{ path, content: text }],
        },
      });
    }
    if (method === "GET" && url.pathname === `${sourcePath}/history`)
      return route.fulfill({ json: { items: [history()], total: 1 } });
    if (method === "GET" && url.pathname === `${sourcePath}/history/2`)
      return route.fulfill({ json: { ...history(), documents: [{ path, content: text }] } });
    if (method === "GET" && [sourcePath, filePath].includes(url.pathname)) {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          const body = JSON.parse(response.body);
          require(body.id === recordId, "Canonical identity required");
          if (url.pathname === sourcePath)
            return route.fulfill({
              ...response,
              body: JSON.stringify({
                ...body,
                source_type: "inline",
                source_uri: "inline://handbook",
                status: "active",
                version: versionToken(),
              }),
            });
          savedFile = replacement ?? { ...body, filename };
          events.push(`file-get-${filename}`);
          return route.fulfill({ ...response, body: JSON.stringify(savedFile) });
        },
      });
    }
    if (url.pathname === `${filePath}/replace` && method === "POST") {
      const body = request.postDataJSON();
      require(Object.keys(body).sort().join() ===
        "content_base64,content_type,filename", "Replacement POST contract drift");
      require(savedFile &&
        body.filename === newName &&
        body.content_type ===
          "text/markdown", "Replacement must transmit chosen filename and MIME");
      require(Buffer.from(body.content_base64, "base64").toString("utf8") ===
        fileText, "Replacement bytes differ");
      require(filename !== newName, "Only one replacement allowed");
      filename = body.filename;
      fileContent = fileText;
      events.push("file-replace");
      replacement = {
        ...savedFile,
        filename,
        content_type: body.content_type,
        size_bytes: Buffer.byteLength(fileText),
        updated_at: "2025-07-12T12:00:00.000Z",
        replaced_at: "2025-07-12T12:00:00.000Z",
      };
      return route.fulfill({ json: replacement });
    }
    if (url.pathname === `${filePath}/content` && method === "GET")
      return route.fulfill({ status: 200, contentType: "text/markdown", body: fileContent });
    if ([sourcePath, filePath].includes(url.pathname) && method !== "GET")
      throw new Error("Unexpected rename/metadata mutation in write evidence");
    return route.fallback();
  };
  await page.route("**/v1/**", handler);
  try {
    await stand.visit(page, `knowledge/${recordId}`);
    if (!(await page.getByTestId("knowledge-edit").isVisible()))
      await page.getByTestId("detail-menu").click();
    await page.getByTestId("knowledge-edit").click();
    const edit = page.getByTestId("knowledge-edit-dialog");
    await page.getByTestId("knowledge-edit-text").filter({ visible: true }).waitFor();
    require((await page.getByTestId("knowledge-edit-text").inputValue()) ===
      initial, "Stored source content required");
    await page.getByTestId("knowledge-edit-text").fill(revised);
    await page.getByTestId("knowledge-edit-note").fill(`  ${note}  `);
    await edit.getByRole("button", { name: t("common.save"), exact: true }).click();
    await edit.waitFor({ state: "hidden" });
    require(events.filter((event) => event === "content-put").length ===
      1, "Exactly one note/content PUT required");
    await stand.visit(page, `knowledge/${recordId}`);
    await page.getByTestId("knowledge-versions-toggle").click();
    await page
      .getByTestId(/^knowledge-versions-(?:mobile-)?row-link-0$/)
      .filter({ visible: true })
      .click();
    await page.getByTestId("knowledge-version-facts").filter({ hasText: note }).waitFor();
    await capture("knowledge-note-put-persisted");
    await stand.visit(page, `files/${recordId}`);
    await page.getByTestId("file-menu").click();
    await page.getByTestId("file-replace").click();
    await page
      .getByTestId("files-upload-drop-input")
      .setInputFiles({ name: newName, mimeType: "text/markdown", buffer: Buffer.from(fileText) });
    const upload = page.getByTestId("files-upload-dialog");
    await upload.getByRole("button", { name: t("files.replace"), exact: true }).click();
    await upload.waitFor({ state: "hidden" });
    await page.getByTestId("file-sheet-title").filter({ hasText: newName }).waitFor();
    require(events.filter((event) => event === "file-replace").length ===
      1, "Exactly one replacement POST required");
    const replaceIndex = events.indexOf("file-replace");
    require(events
      .slice(replaceIndex + 1)
      .includes(`file-get-${newName}`), "Must refetch persisted replacement name");
    await stand.visit(page, `files/${recordId}`);
    await page.getByTestId("file-sheet-title").filter({ hasText: newName }).waitFor();
    await page.getByTestId("file-sheet").filter({ hasText: "Use the revised process." }).waitFor();
    await capture("file-replacement-name-persisted");
  } finally {
    await page.unroute("**/v1/**", handler);
  }
}
