import { parse5322 } from "./modules/rfc5322/email-addresses.js";
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  fs,
  getMimeType,
} from "../modules/zip.js/index.js";

const COMPRESSION_LEVEL = 0; // 0 - 9

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

async function exportFolder(exportItem, zipFs) {
  console.log("Exporting", exportItem);

  // If the item has an accountId, it is a folder, whose messages we can export.
  let mboxStrings = [];
  if (exportItem.accountId) {
    let messages = listMessages(exportItem);
    // listMessages() returns a generator, which makes the entire for loop async.
    for await (let message of messages) {
      let raw = await messenger.messages.getRaw(message.id);

      // From escaping according to mboxrd specifications.
      raw = raw.replace(/^(>*)(From\s)/m, "$1>$2");

      // Minimal compatibility.
      let parsed = parse5322.parseOneAddress(message.author);
      if (!parsed && message.author.indexOf("<") != -1) {
        let author = message.author.split("<");
        author[0] = `"${author[0]}"`;
        parsed = parse5322.parseOneAddress(author.join("<"));
      }
      let address = parsed ? parsed.address : message.author;
      raw = `From ${address} ${message.date.toUTCString()}\n` + raw;

      // Extra newline skipped for first message.
      // We cannot just create one large mbox string, as we could exceed the max
      // string limit and therefore cannot use join to sneak in the line break.
      if (mboxStrings.length > 0) {
        mboxStrings.push("\n");
      }
      mboxStrings.push(raw);
    }
  }
  let totalSize = mboxStrings.reduce((total, item) => item.length + total, 0);

  /*
  // The Blob constructor accepts a sequence and each element may not exceed 2GB,
  // split the data into smaller chunks.
  let sequence = [];
  let chunkSize = 1024 * 1024 * 1024 * 3;
  let totalSize = mboxStrings.reduce((total, item) => item.length + total, 0);
  {
    let pos = 0;
    while (pos + chunkSize <= totalSize) {
      sequence.push(new Uint8Array(chunkSize));
      pos += chunkSize;
    }
    sequence.push(new Uint8Array(totalSize - pos));
  }*/

  // Convert binary mbox strings to Uint8Array(s). 
  let pos = 0;
  let mboxBytes = new Uint8Array(totalSize);
  for (let mboxString of mboxStrings) {
    for (let i = 0; i < mboxString.length; i++) {
      //let currSequence = Math.floor(pos / chunkSize);
      //let offset = currSequence * chunkSize
      //sequence[currSequence][pos - offset] = mboxString.charCodeAt(i) & 0xff;
      mboxBytes[pos++] = mboxString.charCodeAt(i) & 0xff;
      //pos++
    }
  }
  //let blob = new Blob(sequence, { type: "text/plain" });

  // If no zip object given, return just the blob.
  if (!zipFs) {
    return mboxBytes.buffer;//blob;
  }

  // Attach content of this folder as an mboxrd file.
  zipFs.addUint8Array(`${exportItem.name}.mboxrd`, mboxBytes, { useWebWorkers: false }); // webWorkers cause a CSP violation 

  // Recursively attach subfolders.
  for (let subFolder of exportItem.subFolders || exportItem.folders) {
    let zipDir = zipFs.addDirectory(subFolder.name);
    await exportFolder(subFolder, zipDir);
  }
  return null;
}

function getReadableSize(bytes) {
  let units = ["KB", "MB", "TB"];
  let readableSize = units.reduce((rv, unit) => {
    if (rv.size / 1024 > 1) {
      return { size: rv.size / 1024, bytes, unit }
    } else {
      return rv
    }
  }, { size: bytes, bytes, unit: "B" });

  readableSize.roundedSize = Math.round(readableSize.size * 100) / 100;
  return readableSize;
}

// Menu click listener.
async function onExport(clickData, tab) {
  let exportItem = clickData.selectedFolder || clickData.selectedAccount;
  if (!exportItem || !tab.mailTab) {
    return;
  }

  let blob;
  let filename;
  if (exportItem.subFolders?.length || exportItem.folders?.length) {
    let zipFs = new fs.FS();
    await exportFolder(exportItem, zipFs);
    console.log("Export Start")
    blob = await zipFs.exportBlob({ level: COMPRESSION_LEVEL });
    console.log("Export Stop")
    filename = `${exportItem.name}.zip`;
  } else {
    blob = await exportFolder(exportItem);
    filename = `${exportItem.name}.mbox`;
  }

  let url = URL.createObjectURL(blob);
  let readableSize = getReadableSize(blob.size);
  console.log(`${readableSize.roundedSize} ${readableSize.unit} (${readableSize.bytes} bytes)`);

  // Initiate download.
  console.log("Downloading")
  let downloadId;
  try {
    downloadId = await browser.downloads.download({
      filename,
      url,
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

  URL.revokeObjectURL(url);
  console.log("Done.");
}

// Menu click listener.
/*async function onExportOld(clickData, tab) {
  let exportItem = clickData.selectedFolder || clickData.selectedAccount;
  if (!exportItem || !tab.mailTab) {
    return;
  }

  let buffer;
  let type;
  let filename;
  if (exportItem.subFolders?.length || exportItem.folders?.length) {
    let zip = new JSZip();
    await exportFolder(exportItem, zip);
    buffer = await zip.generateAsync({ type: "arraybuffer" });
    type = "application/zip";
    filename = `${exportItem.name}.zip`;
  } else {
    buffer = await exportFolder(exportItem);
    type = "text/plain";
    filename = `${exportItem.name}.mbox`;
  }

  // The Blob constructor accepts a sequence and each element may not exceed 2GB,
  // split the data into smaller chunks.
  let pos = 0;
  let chunk = 1024 * 1024 * 1024;
  let sequence = [];
  while (pos + chunk <= buffer.byteLength) {
    sequence.push(new Uint8Array(buffer, pos, chunk));
    pos += chunk;
  }
  sequence.push(new Uint8Array(buffer, pos));

  let blob = new Blob(sequence, { type });
  let url = URL.createObjectURL(blob);
  let readableSize = getReadableSize(blob.size);
  console.log(`${readableSize.roundedSize} ${readableSize.unit} (${readableSize.bytes} bytes)`);

  // Initiate download.
  console.log("Downloading")
  let downloadId;
  try {
    downloadId = await browser.downloads.download({
      filename,
      url,
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

  URL.revokeObjectURL(url);
  console.log("Done.");
}*/

async function onImport({ selectedFolder }, tab) {
  console.log(selectedFolder);
  let popupUrl = new URL(messenger.runtime.getURL("/popup/import.html"));

  await messenger.windows.create({
    height: 170,
    width: 500,
    url: popupUrl.href,
    type: "popup"
  });
}

messenger.menus.create({
  contexts: ["folder_pane"],
  id: "mbox_export",
  title: "Export mboxrd files(s)",
  onclick: onExport
});

messenger.menus.create({
  contexts: ["folder_pane"],
  id: "mbox_import",
  title: "Import mboxrd file(s)",
  onclick: onImport
})
