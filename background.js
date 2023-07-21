import { parse5322 } from "./email-addresses.js";

// Generator function to loop more easily over message pages.
async function* listMessages(folder) {
  let page = await messenger.messages.list(folder);
  for (let message of page.messages) {
    yield message;
  }

  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    for (let message of page.messages) {
      yield message;
    }
  }
}

// Menu click listener.
messenger.menus.onClicked.addListener(async ({ selectedFolder }, tab) => {
  console.log(selectedFolder);
  if (!selectedFolder || !tab.mailTab) {
    return;
  }

  let data = [];
  let factor = 1;

  let messages = listMessages(selectedFolder);
  // listMessages() returns a generator, which makes the entire for loop async.
  for await (let message of messages) {
    let raw = await messenger.messages.getRaw(message.id);

    // From escaping according to mboxrd.
    raw = raw.replace(/^(>*)(From\s)/m, "$1>$2");
    // Minimal compatibility.
    raw = `From ${parse5322.parseOneAddress(message.author).address} ${message.date.toUTCString()}\n` + raw
    // Extra newline skipped for first message.
    if (data.length > 0) {
      raw = "\n" + raw;
    }

    // Convert binary string to Uint8Array
    let bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i) & 0xff;
    }

    for (let i = 0; i < factor; i++) {
      data.push(bytes);
    }
  }

  // Create downloadable blob.
  let blob = new Blob(data, { type: "text/plain" });
  let url = URL.createObjectURL(blob);

  // Do some size calculations and use a human readable format.
  let size = blob.size;
  let units = ["KB", "MB", "TB"];
  let readableSize = units.reduce((rv, unit) => {
    if (rv.size / 1024 > 1) {
      return { size: rv.size / 1024, unit }
    } else {
      return rv
    }
  }, { size, unit: "B" });
  console.log(`${Math.round(readableSize.size * 100) / 100} ${readableSize.unit} (${size} bytes)`);

  // Initiate download.
  let downloadId;
  try {
    downloadId = await browser.downloads.download({
      url,
      filename: `${selectedFolder.name}.mbox`,
      saveAs: true
    });
  } catch (ex) {
    console.error(ex);
  }

  // Monitor download.
  if (downloadId) {
    // While the download is ongoing, we poll the download manager every second
    // to get an update. However, the "bytesReceived" are always the full size,
    // no incremental progress (probably because it is not a real download). :-(
    let pollId = window.setInterval(async () => {
      let [searching] = await browser.downloads.search({ id: downloadId });
      console.log(JSON.stringify(searching));
    }, 1000);

    await new Promise(resolve => {
      let listener = downloadDelta => {
        if (downloadDelta.id != downloadId) {
          return;
        }

        console.log(downloadDelta);
        if (downloadDelta.state && (
          downloadDelta.state.current == "complete" ||
          downloadDelta?.state.current == "interrupted"
        )) {
          browser.downloads.onChanged.removeListener(listener);
          resolve();
        }
      }
      browser.downloads.onChanged.addListener(listener);
    })

    window.clearInterval(pollId);
  }

  console.log("Done.");
  URL.revokeObjectURL(url);
})

messenger.menus.create({
  contexts: ["folder_pane"],
  id: "mbox_export",
  title: "MBOX Export"
});

