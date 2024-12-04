function base64ToBlob(base64, contentType = '') {
   const byteCharacters = atob(base64.split(',')[1]); // Strip out the prefix (e.g., "data:image/png;base64,")
   const byteArrays = [];
   for (let i = 0; i < byteCharacters.length; i += 512) {
       const slice = byteCharacters.slice(i, i + 512);
       const byteNumbers = new Array(slice.length);
       for (let j = 0; j < slice.length; j++) {
           byteNumbers[j] = slice.charCodeAt(j);
       }
       byteArrays.push(new Uint8Array(byteNumbers));
   }
   return new Blob(byteArrays, { type: contentType });
}

export { base64ToBlob };
