/**
 * Masks geolocation bytes in exif data in jpeg files with zero-ish bytes
 * References: https://www.media.mit.edu/pia/Research/deepview/exif.html & https://exiftool.org/TagNames/GPS.html
 * @param {File} file 
 */
const getFileWithGeolocationExifMasked = async (file) => {
    try {
        if (file.type === 'image/jpeg') {
            const buffer = await file.arrayBuffer();
            let dataview = new DataView(buffer);

            if (dataview.getUint16(0, false) !== 0xffd8) {
                throw new Error('jpeg start of image marker not found');
            }

            let offset = 2; // skipping ffd8 bytes. offset variable is kept for markers-level offsets
            let gpsInfoIfdFound = false;

            while (offset < dataview.byteLength) {
                // if start of scan marker reached, no more app1 markers can be found
                if (dataview.getUint16(offset, false) === 0xffda) {
                    break;
                }

                if (dataview.getUint16(offset, false) === 0xffe1) {
                    // APP1 marker
                    let t = offset;
                    // using t for inside-app1-marker offsetting but at ifd entry-level only. it will never point to bytes inside an ifd entry

                    offset = offset + 2 + dataview.getUint16(offset + 2, false); // point offset to start of next marker

                    t = t + 4; // ffe1 (2 bytes) + length of ffe1 (2 bytes) to reach start of Exif identifier

                    if (
                        !(
                            String.fromCharCode(dataview.getUint8(t)) === 'E' &&
                            String.fromCharCode(dataview.getUint8(t + 1)) === 'x' &&
                            String.fromCharCode(dataview.getUint8(t + 2)) === 'i' &&
                            String.fromCharCode(dataview.getUint8(t + 3)) === 'f'
                        )
                    ) {
                        continue; // this APP1 is not used for Exif
                    }

                    t = t + 4 + 2; // E x i f 00 00 , move 6 bytes to reach tiff header start

                    let tiffHeaderStart = t;

                    let isLittleEndian;
                    if (dataview.getUint16(tiffHeaderStart, false) === 0x4d4d) {
                        isLittleEndian = false; // MM
                    } else if (dataview.getUint16(tiffHeaderStart, false) === 0x4949) {
                        isLittleEndian = true; // II
                    }

                    t = t + dataview.getUint32(t + 2 + 2, isLittleEndian); // 4d4d002aOOOOOOOO or 49492a00OOOOOOOO, reading the 32-bit offset mentioned by O value to start of ifd0

                    let noOfIfdEntries = dataview.getUint16(t, isLittleEndian);
                    t = t + 2; // move past count bytes to start of 1st entry
                    for (let i = 0; i < noOfIfdEntries; i++) {
                        // if GPSInfo ifd entry found
                        if (dataview.getUint16(t, isLittleEndian) === 0x8825) {
                            gpsInfoIfdFound = true;

                            // each ifd is 12 bytes, last 4 bytes indicate value (here offset to gpsinfo sub-ifd from tiff header start) TTFFCCCCVVVV
                            let gpsSubIfdStart = tiffHeaderStart + dataview.getUint32(t + 8, isLittleEndian);
                            let noOfGpsSubIfdEntries = dataview.getUint16(gpsSubIfdStart, isLittleEndian);

                            // using gt for inside-gps-sub-ifd offsetting but at sub-ifd-entry level only, it will never point to bytes inside a sub-ifd entry
                            let gt = gpsSubIfdStart + 2; // skip 2 bytes of count to go to 1st entry

                            for (let j = 0; j < noOfGpsSubIfdEntries; j++) {
                                // TTFFCCCCVVVV - 2 bytes of tag, 2 bytes for format, 4 bytes for components count, 4 bytes of value
                                let format = dataview.getUint16(gt + 2, isLittleEndian);
                                let noOfComponents = dataview.getUint32(gt + 2 + 2, isLittleEndian);
                                let value = dataview.getUint32(gt + 2 + 2 + 4, isLittleEndian);

                                // unsigned byte format
                                if (format === 1) {
                                    if (noOfComponents * 1 <= 4) {
                                        // each component takes 1 bytes
                                        dataview.setUint32(gt + 2 + 2 + 4, 0x00000002, isLittleEndian); // overwrite VVVV bytes with 0
                                    } else {
                                        for (let m = 0; m < noOfComponents; m++) {
                                            dataview.setUint8(tiffHeaderStart + value + m, 48);
                                        }
                                        // if actual is stored at offset, fill all components's value bytes with 0
                                        // for ex: if there are 5 components each with 1 byte size, fill all 5 bytes with 0
                                    }
                                }

                                // ascii string format
                                if (format === 2) {
                                    if (noOfComponents * 1 <= 4) {
                                        // each component takes 1 bytes
                                        dataview.setUint32(gt + 2 + 2 + 4, 0x00000000, isLittleEndian); // overwrite VVVV bytes with 0
                                    } else {
                                        for (let m = 0; m < noOfComponents; m++) {
                                            dataview.setUint8(tiffHeaderStart + value + m, 48);
                                        }
                                    }
                                }

                                // unsigned rational format
                                if (format === 5) {
                                    // always stored at offset as value cannot fit in 4 bytes of VVVV

                                    let vt = value; // using vt for offsetting at actual value area of this subifd entry
                                    for (let k = 0; k < noOfComponents; k++) {
                                        dataview.setUint32(tiffHeaderStart + vt, 0x00000000, isLittleEndian); // numerator 4 bytes
                                        dataview.setUint32(tiffHeaderStart + vt + 4, 0x00000001, isLittleEndian); // denominator 4 bytes, keeping 1 to avoid division-by-0 error in image parser softwares

                                        vt = vt + 8; // each component is 8 bytes in length
                                    }
                                }

                                // signed rational format
                                if (format === 10) {
                                    // always stored at offset as value cannot fit in 4 bytes of VVVV

                                    let vt = value; // using vt for offsetting at actual value area of this subifd entry
                                    for (let k = 0; k < noOfComponents; k++) {
                                        dataview.setUint32(tiffHeaderStart + vt, 0x00000000, isLittleEndian); // numerator 4 bytes
                                        dataview.setUint32(tiffHeaderStart + vt + 4, 0x00000001, isLittleEndian); // denominator 4 bytes, keeping 1 to avoid division-by-0 error in image parser softwares

                                        vt = vt + 8;
                                    }
                                }

                                gt = gt + 12;
                            }
                        }
                        t = t + 12; // point t to start of next IFD entry
                    }
                } else {
                    offset = offset + 2 + dataview.getUint16(offset + 2, false); // point offset to start of next marker

                    // note: putting this in else & duplicated same in IF also because IF has continue statement which can bypass this statement if kept without else
                }
            }

            if (!gpsInfoIfdFound) {
                return file;
            }

            const blob = new Blob([dataview.buffer], { type: file.type });
            const newFile = new File([blob], file.name, { type: file.type });

            return newFile;
        } else {
            return file;
        }
    } catch (error) {
        console.log('Geolocation Exif masking error : ', error); // not throwing hard error if exif masking process gives error
        return file;
    }
};

/* sample usage

HTML : <input type="file" id="fileInput" accept="image/*"></input>

JS : fileInput.addEventListener('change', async function(event) {
    const file = event.target.files[0];
    const newFile = getFileWithGeolocationExifMasked(file);
}
*/