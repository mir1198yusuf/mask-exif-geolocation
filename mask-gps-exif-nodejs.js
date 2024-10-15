const fs = require('fs');

/**
 * Masks geolocation bytes in exif data in jpeg files with zero-ish bytes
 * References: https://www.media.mit.edu/pia/Research/deepview/exif.html & https://exiftool.org/TagNames/GPS.html
 */
const maskGeolocationExifData = async (
    fileName,
    pathWithoutFileName,
    mimeType,
    deleteOldFile
) => {
    try {
        if (mimeType === 'image/jpeg') {
            function readUInt32(buffer, offset, endian) {
                if (endian === 'bigEndian') return buffer.readUInt32BE(offset);
                else if (endian === 'littleEndian')
                    return buffer.readUInt32LE(offset);
            }
            function readUInt16(buffer, offset, endian) {
                if (endian === 'bigEndian') return buffer.readUInt16BE(offset);
                else if (endian === 'littleEndian')
                    return buffer.readUInt16LE(offset);
            }
            function writeUInt32(buffer, value, offset, endian) {
                if (endian === 'bigEndian') buffer.writeUInt32BE(value, offset);
                else if (endian === 'littleEndian')
                    buffer.writeUInt32LE(value, offset);
            }
            function writeInt32(buffer, value, offset, endian) {
                if (endian === 'bigEndian') buffer.writeInt32BE(value, offset);
                else if (endian === 'littleEndian')
                    buffer.writeInt32LE(value, offset);
            }

            const buffer = fs.readFileSync(
                `${pathWithoutFileName}/${fileName}`
            );

            if (buffer.readUInt16BE(0) !== 0xffd8) {
                throw new Error('jpeg start of image marker not found');
            }

            let offset = 2; // skipping ffd8 bytes. offset variable is kept for markers-level offsets
            let gpsInfoIfdFound = false;

            while (offset < Buffer.byteLength(buffer)) {
                // if start of scan marker reached, no more app1 markers can be found
                if (buffer.readUInt16BE(offset) === 0xffda) {
                    break;
                }

                if (buffer.readUInt16BE(offset) === 0xffe1) {
                    // APP1 marker
                    let t = offset;
                    // using t for inside-app1-marker offsetting but at ifd entry-level only. it will never point to bytes inside an ifd entry

                    offset = offset + 2 + buffer.readUInt16BE(offset + 2); // point offset to start of next marker

                    t = t + 4; // ffe1 (2 bytes) + length of ffe1 (2 bytes) to reach start of Exif identifier

                    if (buffer.toString('ascii', t, t + 4) !== 'Exif') {
                        continue; // this APP1 is not used for Exif
                    }

                    t = t + 4 + 2; // E x i f 00 00 , move 6 bytes to reach tiff header start

                    let tiffHeaderStart = t;

                    let endian;
                    if (buffer.readUInt16BE(tiffHeaderStart) === 0x4d4d) {
                        endian = 'bigEndian'; // MM
                    } else if (
                        buffer.readUInt16BE(tiffHeaderStart) === 0x4949
                    ) {
                        endian = 'littleEndian'; // II
                    }

                    t = t + readUInt32(buffer, t + 2 + 2, endian); // 4d4d002aOOOOOOOO or 49492a00OOOOOOOO, reading the 32-bit offset mentioned by O value to start of ifd0

                    let noOfIfdEntries = readUInt16(buffer, t, endian);
                    t = t + 2; // move past count bytes to start of 1st entry
                    for (let i = 0; i < noOfIfdEntries; i++) {
                        // if GPSInfo ifd entry found
                        if (readUInt16(buffer, t, endian) === 0x8825) {
                            gpsInfoIfdFound = true;

                            // each ifd is 12 bytes, last 4 bytes indicate value (here offset to gpsinfo sub-ifd from tiff header start) TTFFCCCCVVVV
                            let gpsSubIfdStart =
                                tiffHeaderStart +
                                readUInt32(buffer, t + 8, endian);
                            let noOfGpsSubIfdEntries = readUInt16(
                                buffer,
                                gpsSubIfdStart,
                                endian
                            );

                            // using gt for inside-gps-sub-ifd offsetting but at sub-ifd-entry level only, it will never point to bytes inside a sub-ifd entry
                            let gt = gpsSubIfdStart + 2; // skip 2 bytes of count to go to 1st entry

                            for (let j = 0; j < noOfGpsSubIfdEntries; j++) {
                                // TTFFCCCCVVVV - 2 bytes of tag, 2 bytes for format, 4 bytes for components count, 4 bytes of value
                                let format = readUInt16(buffer, gt + 2, endian);
                                let noOfComponents = readUInt32(
                                    buffer,
                                    gt + 2 + 2,
                                    endian
                                );
                                let value = readUInt32(
                                    buffer,
                                    gt + 2 + 2 + 4,
                                    endian
                                );

                                // unsigned byte format
                                if (format === 1) {
                                    if (noOfComponents * 1 <= 4) {
                                        // each component takes 1 bytes
                                        writeUInt32(
                                            buffer,
                                            0x00000002, // since 0 & 1 are valid values, putting 2, can put any value here
                                            gt + 2 + 2 + 4,
                                            endian
                                        ); // overwrite VVVV bytes with 0
                                    } else {
                                        buffer.write(
                                            '0'.repeat(noOfComponents), // use ascii 0, decimal 48. can put anything here
                                            tiffHeaderStart + value,
                                            1 * noOfComponents
                                        );
                                        // if actual is stored at offset, fill all components's value bytes with 0
                                        // for ex: if there are 5 components each with 1 byte size, fill all 5 bytes with 0
                                    }
                                }

                                // ascii string format
                                if (format === 2) {
                                    if (noOfComponents * 1 <= 4) {
                                        // each component takes 1 bytes
                                        writeUInt32(
                                            buffer,
                                            0x00000000,
                                            gt + 2 + 2 + 4,
                                            endian
                                        ); // overwrite VVVV bytes with 0
                                    } else {
                                        buffer.write(
                                            '0'.repeat(noOfComponents), // use ascii 0, decimal 48. can put anything here
                                            tiffHeaderStart + value,
                                            1 * noOfComponents
                                        );
                                    }
                                }

                                // unsigned rational format
                                if (format === 5) {
                                    // always stored at offset as value cannot fit in 4 bytes of VVVV

                                    let vt = value; // using vt for offsetting at actual value area of this subifd entry
                                    for (let k = 0; k < noOfComponents; k++) {
                                        writeUInt32(
                                            buffer,
                                            0x00000000,
                                            tiffHeaderStart + vt,
                                            endian
                                        ); // numerator 4 bytes
                                        writeUInt32(
                                            buffer,
                                            0x00000001,
                                            tiffHeaderStart + vt + 4,
                                            endian
                                        ); // denominator 4 bytes, keeping 1 to avoid division-by-0 error in image parser softwares

                                        vt = vt + 8; // each component is 8 bytes in length
                                    }
                                }

                                // signed rational format
                                if (format === 10) {
                                    // always stored at offset as value cannot fit in 4 bytes of VVVV

                                    let vt = value; // using vt for offsetting at actual value area of this subifd entry
                                    for (let k = 0; k < noOfComponents; k++) {
                                        writeInt32(
                                            buffer,
                                            0x00000000,
                                            tiffHeaderStart + vt,
                                            endian
                                        ); // numerator 4 bytes
                                        writeInt32(
                                            buffer,
                                            0x00000001,
                                            tiffHeaderStart + vt + 4,
                                            endian
                                        ); // denominator 4 bytes, keeping 1 to avoid division-by-0 error in image parser softwares

                                        vt = vt + 8;
                                    }
                                }

                                gt = gt + 12;
                            }
                        }
                        t = t + 12; // point t to start of next IFD entry
                    }
                } else {
                    offset = offset + 2 + buffer.readUInt16BE(offset + 2); // point offset to start of next marker

                    // note: putting this in else & duplicated same in IF also because IF has continue statement which can bypass this statement if kept without else
                }
            }

            if (!gpsInfoIfdFound) {
                return { isGpsExifMasked: false };
            }

            const newFileName = `new_${fileName}`;
            const newFilePath = `${pathWithoutFileName}/${newFileName}`;
            fs.writeFileSync(newFilePath, buffer);

            const oldFilePath = `${pathWithoutFileName}/${fileName}`;

            // this function does not remove/add any bytes, so bytes size should remain same. if not, means some issue occured
            if (
                fs.statSync(oldFilePath).size !== fs.statSync(newFilePath).size
            ) {
                fs.unlinkSync(newFilePath);
                throw new Error('bytes size dont match');
            }

            deleteOldFile && fs.unlinkSync(oldFilePath);

            return { isGpsExifMasked: true, newFileName, newFilePath };
        } else {
            return { isGpsExifMasked: false };
        }
    } catch (error) {
        console.log('Geolocation Exif masking error : ', error); // not throwing hard error if exif masking process gives error
        return { isGpsExifMasked: false };
    }
};

maskGeolocationExifData('sampleImage.jpg', 'uploads/test', 'image/jpeg', true); // sample function call
