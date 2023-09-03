import {
  fs,
  getMimeType,
} from "../modules/zip.js/index.js";

const urlParams = new URLSearchParams(window.location.search);
let msgId = parseInt(urlParams.get('msgId'), 10);
let tabId = parseInt(urlParams.get('tabId'), 10);
let busy = false;

window.addEventListener("beforeunload", event => {
  if (busy) {
    event.preventDefault();
  };
})

document.getElementById("import_cancel").addEventListener('click', cancel);
document.getElementById("import_ok").addEventListener('click', ok);
document.getElementById("body").style.display = "block";

async function cancel(e) {
  let popupTab = await messenger.tabs.getCurrent();
  await messenger.tabs.remove(popupTab.id);
}

function findEntry(children) {
  let file = children.find(e => !e.directory && e.uncompressedSize > 0 && e.uncompressedSize < 50830578) ;
  console.log({file});
  if (file) return file;

  let dirs = children.filter(e => e.directory);
  console.log({dirs});
  for (let dir of dirs) {
    let file = findEntry(dir.children)
    if (file) {
      return file;
    }
  }
}

async function ok(e) {
  let files = document.getElementById("import_file").files;
  if (files.length != 1) {
    return;
  }

  let zipFs = new fs.FS();
  await zipFs.importBlob(files[0], {useWebWorkers: false}); // webWorkers cause a CSP violation
  console.log(zipFs.children);
  
  const firstEntry = findEntry(zipFs.children);
  const unzippedBlob = await firstEntry.getBlob(getMimeType(firstEntry.name));
  const text = await unzippedBlob.text();
  console.log({unzippedBlob, text});
}
