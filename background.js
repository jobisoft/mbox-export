import { fs, configure } from "./modules/zip.js/index.js";

const COMPRESSION_LEVEL = 6; // 0 - 9

// Define paths to overcome CSP violations from webWorkers.
configure({
  useWebWorkers: true,
  workerScripts: {
    deflate: [browser.runtime.getURL("./modules/zip.js/dist/z-worker.js")],
    inflate: [browser.runtime.getURL("./modules/zip.js/dist/z-worker.js")],
  }
});

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

// Return a human readable file size.
function getReadableSize(bytes) {
  let units = ["KB", "MB", "GB", "TB"];
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

// Extract messages and do mboxrd escaping and return a UInt8Array. If a
// fileSizeLimit is specified, the function will not create one mbox file but
// multiple mbox files, each not being larger as specified.
async function getMboxFiles(folderOrAccount, { fileSizeLimit = 0 }) {
  // Split mbox files in chunks as specified by fileSizeLimit and return an array
  // of bytes.

  // If the item has an accountId, it is a folder, whose messages we can export.
  let mboxFiles = [];
  if (folderOrAccount.accountId) {
    let mboxString = "";
    let mboxStrings = [];
    let messages = listMessages(folderOrAccount);
    // listMessages() returns a generator, which makes the entire for loop async.
    for await (let message of messages) {
      let raw = await messenger.messages.getRaw(message.id);

      // From escaping according to mboxrd specifications.
      raw = raw.replace(/^(>*)(From\s)/m, "$1>$2");

      // Minimal compatibility.
      let parsed = await browser.messengerUtilities.parseMailboxString(message.author);
      raw = `From ${parsed[0].email} ${message.date.toUTCString()}\n` + raw;

      if (fileSizeLimit && mboxString.length + raw.length > fileSizeLimit) {
        mboxStrings.push(mboxString);
        mboxString = "";
      }

      // Extra newline skipped for first message.
      // We cannot just create one large mbox string, as we could exceed the max
      // string limit and therefore cannot use join to sneak in the line break.
      if (mboxString.length > 0) {
        mboxString += "\n";
      }
      mboxString += raw;
    }
    if (mboxString.length > 0) mboxStrings.push(mboxString);

    for (let mboxString of mboxStrings) {
      // Convert binary mbox strings to Uint8Array.
      let mboxBytes = new Uint8Array(mboxString.length);
      for (let i = 0; i < mboxString.length; i++) {
        mboxBytes[i] = mboxString.charCodeAt(i) & 0xff;
      }
      mboxFiles.push(mboxBytes)
    }

  }
  return mboxFiles;
}

// Exports the given item to a single blob/mbox file.
async function getMboxBlob(folderOrAccount) {
  // Force export into a single mbox file.
  let mboxFiles = await getMboxFiles(folderOrAccount, { fileSizeLimit: 0 });
  if (mboxFiles.length != 1) {
    return;
  }

  let bytes = mboxFiles[0];
  let buffer = bytes.buffer;
  // The Blob constructor accepts a sequence and each element may not exceed 2GB,
  // split the data into smaller chunks.
  let pos = 0;
  let chunk = 1024 * 1024 * 1024;
  let sequence = [];
  while (pos + chunk <= bytes.byteLength) {
    sequence.push(new Uint8Array(buffer, pos, chunk));
    pos += chunk;
  }
  sequence.push(new Uint8Array(buffer, pos));
  return new Blob(sequence, { type: "text/plain" });
}

// Exports the given item and adds it to a zip object. Large mbox files are split.
async function addItemToZip(exportItem, zipFs) {
  // Force multiple files if larger then 2GB.
  let mboxFiles = await getMboxFiles(exportItem, { fileSizeLimit: 1024 * 1024 * 1024 * 2});

  // Attach content of this folder as one or more mboxrd files.
  if (mboxFiles.length > 1) {
    for (let i = 0; i < mboxFiles.length; i++) {
      await zipFs.addUint8Array(`${exportItem.name}_${i}.mboxrd`, mboxFiles[i]);
    }
  } else if (mboxFiles.length == 1) {
    await zipFs.addUint8Array(`${exportItem.name}.mboxrd`, mboxFiles[0]);
  } else {
    console.log(`Skipping ${exportItem.name}`);
  }

  // Recursively attach subfolders.
  for (let subFolder of exportItem.subFolders || exportItem.folders) {
    let zipDir = zipFs.addDirectory(subFolder.name);
    await addItemToZip(subFolder, zipDir);
  }
}

async function getZippedBlob(exportItem) {
  let t1 = Date.now();
  console.log("Start");
  let zipFs = new fs.FS();
  await addItemToZip(exportItem, zipFs);
  console.log("Time needed for adding items:", Date.now() - t1);
  let t2 = Date.now();
  let blob = await zipFs.exportBlob({ level: COMPRESSION_LEVEL });
  console.log("Time needed for exporting Blob:", Date.now() - t2);
  return blob;
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
    blob = await getZippedBlob(exportItem);
    filename = `${exportItem.name}.zip`;
  } else {
    blob = await getMboxBlob(exportItem);
    filename = `${exportItem.name}.mbox`;
  }
  let url = URL.createObjectURL(blob);
  let readableSize = getReadableSize(blob.size);
  console.log(`Downloading ${readableSize.roundedSize} ${readableSize.unit} (${readableSize.bytes} bytes) [${blob.size}]`);

  // Initiate download.
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
    // to get an update.
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
