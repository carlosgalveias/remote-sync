'use strict';
const path = require('path');
const fs = require('fs');

const listFilesFromFolder = function(folder, foundFiles) {
  if (!folder) { folder = './'; }
  if (!foundFiles) {
    foundFiles = [];
  }
  let files;
  try {
    files = fs.readdirSync(path.resolve(folder));
  } catch (e) {
    console.warn('cound not read folder', folder);
    return foundFiles;
  }
  for (const file of files) {
    const filePath = path.join(folder, file);
    const fullPath = path.resolve(filePath);
    if (fs.statSync(filePath).isDirectory()) {
      foundFiles.push({ file: fullPath, type: 'folder' });
      foundFiles = foundFiles.concat(listFilesFromFolder(filePath));
    } else {
      foundFiles.push({ file: fullPath, type: 'file' });
    }
  }
  return foundFiles;
};

module.exports = {
  listFilesFromFolder
};