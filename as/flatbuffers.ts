import {ArrayBufferView} from "arraybuffer";
import {E_INDEXOUTOFRANGE} from "util/error";
import {COMPARATOR} from "util/sort";
import {joinIntegerArray} from "util/string";

export namespace flatbuffers {
    export type Offset = i32;

    // @ts-ignore
    @inline
    export const SIZEOF_SHORT: Offset = 2;
    // @ts-ignore
    @inline
    export const SIZEOF_INT: Offset = 4;
    // @ts-ignore
    @inline
    export const FILE_IDENTIFIER_LENGTH: Offset = 4;
    // @ts-ignore
    @inline
    export const SIZE_PREFIX_LENGTH: Offset = 4;

    export enum Encoding {
        UTF8_BYTES = 0,
        UTF16_STRING = 1,
    }

    @unmanaged
    export class Table {
        bb: ByteBuffer | null = null;
        bb_pos: i32 = 0;
    }

    export class Builder {
        /**
         * @type {flatbuffers.ByteBuffer}
         * @private
         */
        bb: ByteBuffer;
        /**
         * Remaining space in the ByteBuffer.
         *
         * @type {i32}
         * @private
         */
        space: i32;
        /**
         * Minimum alignment encountered so far.
         *
         * @type {number}
         * @private
         */
        minalign: i32;
        /**
         * The vtable for the current table.
         *
         * @type {Array.<number>}
         * @private
         */
        vtable: i32[];
        /**
         * The amount of fields we're actually using.
         *
         * @type {number}
         * @private
         */
        vtable_in_use: i32;
        /**
         * Whether we are currently serializing a table.
         *
         * @type {boolean}
         * @private
         */
        isNested: boolean;
        /**
         * Starting offset of the current struct/table.
         *
         * @type {number}
         * @private
         */
        object_start: i32;
        /**
         * List of offsets of all vtables.
         *
         * @type {Array.<number>}
         * @private
         */
        vtables: i32[];
        /**
         * For the current vector being built.
         *
         * @type {number}
         * @private
         */
        vector_num_elems: i32;
        /**
         * False omits default values from the serialized data
         *
         * @type {boolean}
         * @private
         */
        force_defaults: boolean;

        constructor(opt_initial_size: i32) {
            let initial_size: i32;
            if (opt_initial_size <= 0) {
                initial_size = 1024;
            } else {
                initial_size = opt_initial_size;
            }
            this.bb = new ByteBuffer(new Uint8Array(initial_size), 0);
            this.space = initial_size;
            this.minalign = 1;
            this.vtable = new Array<i32>(16);
            this.vtable_in_use = 0;
            this.isNested = false;
            this.object_start = 0;
            this.vtables = [];
            this.vector_num_elems = 0;
            this.force_defaults = false;
        }

        clear(): void {
            this.bb.clear();
            this.space = this.bb.capacity();
            this.minalign = 1;
            for (let i = 0; i < this.vtable.length; i++) {
                this.vtable[0] = 0;
            }
            this.vtable_in_use = 0;
            this.isNested = false;
            this.object_start = 0;
            this.vtables = [];
            this.vector_num_elems = 0;
            this.force_defaults = false;
        }

        /**
         * In order to save space, fields that are set to their default value
         * don't get serialized into the buffer. Forcing defaults provides a
         * way to manually disable this optimization.
         *
         * @param {boolean} forceDefaults true always serializes default values
         */
        @inline
        forceDefaults(forceDefaults: boolean): void {
            this.force_defaults = forceDefaults;
        }

        /**
         * Get the ByteBuffer representing the FlatBuffer. Only call this after you've
         * called finish(). The actual data starts at the ByteBuffer's current position,
         * not necessarily at 0.
         *
         * @returns {flatbuffers.ByteBuffer}
         */
        @inline
        dataBuffer(): ByteBuffer {
            return this.bb;
        }

        /**
         * Get the bytes representing the FlatBuffer. Only call this after you've
         * called finish().
         *
         * @returns {!Uint8Array}
         */
        @inline
        asUint8Array(): Uint8Array {
            return Uint8Array.wrap(this.bb.bytes_.subarray(
                this.bb.position_, this.bb.position_ + this.offset()).buffer
            );
            // return this.bb.bytes_.subarray(this.bb.position_, this.bb.position_ + this.offset());
        }

        /**
         * Get the bytes representing the FlatBuffer. Only call this after you've
         * called finish().
         *
         * @returns {!Uint8Array}
         */
        @inline
        asByteString(): ByteString {
            return new ByteString(
                this.bb.dataStart_ + this.bb.position_,
                this.offset() - this.bb.position_
            );
        }

        /**
         * Set the current vtable at `voffset` to the current location in the buffer.
         *
         * @param {number} voffset
         */
        @inline
        slot(voffset: Offset): Offset {
            if (this.vtable) return this.vtable[voffset] = this.offset();
            else return (this.vtable = new Array<i32>(voffset + 1))[voffset] = this.offset();
        }

        /**
         * @returns {flatbuffers.Offset} Offset relative to the end of the buffer.
         */
        @inline
        offset(): Offset {
            return this.bb.capacity() - this.space;
        }

        /**
         * Doubles the size of the backing ByteBuffer and copies the old data towards
         * the end of the new buffer (since we build the buffer backwards).
         *
         * @param {flatbuffers.ByteBuffer} bb The current buffer with the existing data
         * @returns {!flatbuffers.ByteBuffer} A new byte buffer with the old data copied
         * to it. The data is located at the end of the buffer.
         *
         * uint8Array.set() formally takes {Array<number>|ArrayBufferView}, so to pass
         * it a uint8Array we need to suppress the type check:
         * @suppress {checkTypes}
         */
        static growByteBuffer(bb: ByteBuffer): ByteBuffer {
            let old_buf_size = bb.capacity();
            // Ensure we don't grow beyond what fits in an int.
            if (old_buf_size & 0xC0000000) {
                throw new Error('FlatBuffers: cannot grow buffer beyond 2 gigabytes.');
            }

            let new_buf_size = old_buf_size << 1;
            let nbb = flatbuffers.ByteBuffer.allocate(new_buf_size);
            nbb.setPosition(new_buf_size - old_buf_size);
            nbb.bytes().set(bb.bytes(), new_buf_size - old_buf_size);
            return nbb;
        }

        /**
         * Prepare to write an element of `size` after `additional_bytes` have been
         * written, e.g. if you write a string, you need to align such the int length
         * field is aligned to 4 bytes, and the string data follows it directly. If all
         * you need to do is alignment, `additional_bytes` will be 0.
         *
         * @param {number} size This is the of the new element to write
         * @param {number} additional_bytes The padding size
         */
        prep(size: i32, additional_bytes: i32): void {
            // Track the biggest thing we've ever aligned to.
            if (size > this.minalign) {
                this.minalign = size;
            }

            // Find the amount of alignment needed such that `size` is properly
            // aligned after `additional_bytes`
            let align_size = ((~(this.bb.capacity() - this.space + additional_bytes)) + 1) & (size - 1);

            // Reallocate the buffer if needed.
            while (this.space < align_size + size + additional_bytes) {
                let old_buf_size = this.bb.capacity();
                this.bb = flatbuffers.Builder.growByteBuffer(this.bb);
                this.space += this.bb.capacity() - old_buf_size;
            }

            this.pad(align_size);
        }

        /**
         * @param {number} byte_size
         */
        pad(byte_size: i32): void {
            this.space -= byte_size;
            memory.fill(<usize>this.space, 0, <usize>byte_size);
            // for (let i = 0; i < byte_size; i++) {
            //     this.bb.writeInt8(--this.space, 0);
            // }
        }

        /**
         * Should not be creating any other object, string or vector
         * while an object is being constructed
         */
        @inline
        notNested(): void {
            if (this.isNested) {
                throw new Error('FlatBuffers: object serialization must not be nested.');
            }
        }

        /**
         * Adds on offset, relative to where it will be written.
         *
         * @param {flatbuffers.Offset} offset The offset to add.
         */
        @inline
        addOffset(offset: Offset): void {
            this.prep(SIZEOF_INT, 0); // Ensure alignment is already done.
            this.writeInt32(this.offset() - offset + SIZEOF_INT);
        }

        /**
         * Start encoding a new object in the buffer.  Users will not usually need to
         * call this directly. The FlatBuffers compiler will generate helper methods
         * that call this method internally.
         *
         * @param {number} numfields
         */
        startObject(numfields: Offset): void {
            this.notNested();
            this.vtable_in_use = numfields;
            while (numfields > this.vtable.length) {
                this.vtable.push(0);
            }
            for (let i = 0; i < numfields; i++) {
                this.vtable[i] = 0;
            }
            this.isNested = true;
            this.object_start = this.offset();
        }

        /**
         * Finish off writing the object that is under construction.
         *
         * @returns {flatbuffers.Offset} The offset to the object inside `dataBuffer`
         */
        endObject(): Offset {
            if (this.vtable == null || !this.isNested) {
                throw new Error('FlatBuffers: endObject called without startObject');
            }

            this.addInt32(0);
            let vtableloc = this.offset();

            // Trim trailing zeroes.
            let i = this.vtable_in_use - 1;
            for (; i >= 0 && this.vtable[i] == 0; i--) {
            }
            let trimmed_size = i + 1;

            // Write out the current vtable.
            for (; i >= 0; i--) {
                // Offset relative to the start of the table.
                this.addInt16(<i16>(this.vtable[i] != 0 ? vtableloc - this.vtable[i] : 0));
            }

            let standard_fields = 2; // The fields below:
            this.addInt16(<i16>(vtableloc - this.object_start));
            let len = (trimmed_size + standard_fields) * SIZEOF_SHORT;
            this.addInt16(<i16>len);

            // Search for an existing vtable that matches the current one.
            let existing_vtable = 0;
            let vt1 = this.space;
            let cont = false;
            for (i = 0; i < this.vtables.length; i++) {
                let vt2 = this.bb.capacity() - this.vtables[i];
                if (len == this.bb.readInt16(vt2)) {
                    cont = false;
                    for (let j = SIZEOF_SHORT; j < len; j += SIZEOF_SHORT) {
                        if (this.bb.readInt16(vt1 + j) != this.bb.readInt16(vt2 + j)) {
                            cont = true;
                            break;
                        }
                    }
                    if (cont) {
                        continue;
                    }
                    existing_vtable = this.vtables[i];
                    break;
                }
            }

            if (existing_vtable) {
                // Found a match:
                // Remove the current vtable.
                this.space = this.bb.capacity() - vtableloc;

                // Point table to existing vtable.
                this.bb.writeInt32(this.space, existing_vtable - vtableloc);
            } else {
                // No match:
                // Add the location of the current vtable to the list of vtables.
                this.vtables.push(this.offset());

                // Point table to current vtable.
                this.bb.writeInt32(this.bb.capacity() - vtableloc, this.offset() - vtableloc);
            }

            this.isNested = false;
            return vtableloc;
        }

        /**
         * Finalize a buffer, pointing to the given `root_table`.
         *
         * @param {flatbuffers.Offset} root_table
         * @param {string=} opt_file_identifier
         * @param {boolean=} opt_size_prefix
         */
        finish(root_table: Offset, opt_file_identifier: string | null = null, opt_size_prefix: boolean = false): void {
            let size_prefix = opt_size_prefix ? SIZE_PREFIX_LENGTH : 0;
            if (opt_file_identifier) {
                let file_identifier = opt_file_identifier;
                this.prep(this.minalign, SIZEOF_INT +
                    FILE_IDENTIFIER_LENGTH + size_prefix);
                if (file_identifier.length != FILE_IDENTIFIER_LENGTH) {
                    throw new Error('FlatBuffers: file identifier must be length ' +
                        FILE_IDENTIFIER_LENGTH.toString());
                }
                for (let i = FILE_IDENTIFIER_LENGTH - 1; i >= 0; i--) {
                    this.writeInt8(<i8>file_identifier.charCodeAt(i));
                }
            }
            this.prep(this.minalign, SIZEOF_INT + size_prefix);
            this.addOffset(root_table);
            if (size_prefix) {
                this.addInt32(this.bb.capacity() - this.space);
            }
            this.bb.setPosition(this.space);
        }

        /**
         * Finalize a size prefixed buffer, pointing to the given `root_table`.
         *
         * @param {flatbuffers.Offset} root_table
         * @param {string=} opt_file_identifier
         */
        finishSizePrefixed(root_table: Offset, opt_file_identifier: string | null = null): void {
            this.finish(root_table, opt_file_identifier, true);
        }

        /**
         * This checks a required field has been set in a given table that has
         * just been constructed.
         *
         * @param {flatbuffers.Offset} table
         * @param {number} field
         */
        @inline
        requiredField(table: Offset, field: i32): void {
            let table_start = this.bb.capacity() - table;
            let vtable_start = table_start - this.bb.readInt32(table_start);
            let ok = this.bb.readInt16(vtable_start + field) != 0;

            // If this fails, the caller will show what field needs to be set.
            if (!ok) {
                throw new Error('FlatBuffers: field ' + field.toString() + ' must be set');
            }
        }

        /**
         * Start a new array/vector of objects. Users usually will not call
         * this directly. The FlatBuffers compiler will create a start/end
         * method for vector types in generated code.
         *
         * @param {number} elem_size The size of each element in the array
         * @param {number} num_elems The number of elements in the array
         * @param {number} alignment The alignment of the array
         */
        @inline
        startVector(elem_size: i32, num_elems: i32, alignment: i32): void {
            this.notNested();
            this.vector_num_elems = num_elems;
            this.prep(SIZEOF_INT, elem_size * num_elems);
            this.prep(alignment, elem_size * num_elems); // Just in case alignment > int.
        }

        /**
         * Finish off the creation of an array and all its elements. The array must be
         * created with `startVector`.
         *
         * @returns {flatbuffers.Offset} The offset at which the newly created array
         * starts.
         */
        @inline
        endVector(): Offset {
            this.writeInt32(this.vector_num_elems);
            return this.offset();
        }

        /**
         * Encode the string `s` in the buffer using UTF-8. If a Uint8Array is passed
         * instead of a string, it is assumed to contain valid UTF-8 encoded data.
         *
         * @param {string|Uint8Array} s The string to encode
         * @return {flatbuffers.Offset} The offset in the buffer where the encoded string starts
         */
        createString(s: string | null): Offset {
            let length: usize;
            let utf8: usize;
            if (s === null) {
                utf8 = 0;
                length = 0;
            } else {
                let b = String.UTF8.encode(s, false);
                length = <usize>b.byteLength;
                utf8 = changetype<usize>(b);
            }

            this.addInt8(0);
            this.startVector(1, <Offset>length, 1);
            this.bb.setPosition(this.space -= <Offset>length);
            for (let i: usize = 0, offset: usize = this.space; i < length; i++) {
                store<u8>(offset++, load<u8>(utf8 + i));
                // bytes[offset++] = utf8[i];
            }
            return this.endVector();
        }

        /**
         *
         * @param s
         */
        createByteString(s: ByteString): Offset {
            this.addInt8(0);
            this.startVector(1, s.length, 1);
            this.bb.setPosition(this.space -= s.length);
            memory.copy(this.space, s.data, s.length);
            return this.endVector();
        }

        createStringBytes(utf8: Uint8Array): Offset {
            this.addInt8(0);
            this.startVector(1, utf8.length, 1);
            this.bb.setPosition(this.space -= utf8.length);
            for (let i = 0, offset = this.space, bytes = this.bb.bytes(); i < utf8.length; i++) {
                bytes[offset++] = utf8[i];
            }
            return this.endVector();
        }

        // createObjectOffset(obj: string | any): void {
        //
        // }

        @inline
        writeInt8(value: i8): void {
            this.bb.writeInt8(this.space -= 1, value);
        }

        @inline
        writeUint8(value: u8): void {
            this.bb.writeUint8(this.space -= 1, value);
        }

        @inline
        writeInt16(value: i16): void {
            this.bb.writeInt16(this.space -= 2, value);
        }

        @inline
        writeUint16(value: u16): void {
            this.bb.writeUint16(this.space -= 2, value);
        }

        @inline
        writeInt32(value: i32): void {
            this.bb.writeInt32(this.space -= 4, value);
        }

        @inline
        writeUint32(value: u32): void {
            this.bb.writeUint32(this.space -= 4, value);
        }

        @inline
        writeInt64(value: i64): void {
            this.bb.writeInt64(this.space -= 8, value);
        }

        @inline
        writeUint64(value: u64): void {
            this.bb.writeUint64(this.space -= 8, value);
        }

        @inline
        writeFloat32(value: f32): void {
            this.bb.writeFloat32(this.space -= 4, value);
        }

        @inline
        writeFloat64(value: f64): void {
            this.bb.writeFloat64(this.space -= 8, value);
        }

        @inline
        addInt8(value: i8): void {
            this.prep(1, 0);
            this.writeInt8(value);
        }

        @inline
        addUint8(value: u8): void {
            this.prep(1, 0);
            this.writeUint8(value);
        }

        @inline
        addInt16(value: i16): void {
            this.prep(2, 0);
            this.writeInt16(value);
        }

        @inline
        addUint16(value: u16): void {
            this.prep(2, 0);
            this.writeInt16(value);
        }

        @inline
        addInt32(value: i32): void {
            this.prep(4, 0);
            this.writeInt32(value);
        }

        @inline
        addUint32(value: u32): void {
            this.prep(4, 0);
            this.writeUint32(value);
        }

        @inline
        addInt64(value: i64): void {
            this.prep(8, 0);
            this.writeInt64(value);
        }

        @inline
        addUint64(value: u64): void {
            this.prep(8, 0);
            this.writeUint64(value);
        }

        @inline
        addFloat32(value: f32): void {
            this.prep(4, 0);
            this.writeFloat32(value);
        }

        @inline
        addFloat64(value: f64): void {
            this.prep(8, 0);
            this.writeFloat64(value);
        }

        @inline
        addFieldInt8(voffset: Offset, value: i8, defaultValue: i8): void {
            if (this.force_defaults || value != defaultValue) {
                this.addInt8(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldUint8(voffset: Offset, value: u8, defaultValue: u8): void {
            if (this.force_defaults || value != defaultValue) {
                this.addUint8(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldInt16(voffset: Offset, value: i16, defaultValue: i16): void {
            if (this.force_defaults || value != defaultValue) {
                this.addInt16(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldUint16(voffset: Offset, value: u16, defaultValue: u16): void {
            if (this.force_defaults || value != defaultValue) {
                this.addUint16(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldInt32(voffset: Offset, value: i32, defaultValue: i32): void {
            if (this.force_defaults || value != defaultValue) {
                this.addInt32(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldUint32(voffset: Offset, value: u32, defaultValue: u32): void {
            if (this.force_defaults || value != defaultValue) {
                this.addUint32(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldInt64(voffset: Offset, value: i64, defaultValue: i64): void {
            if (this.force_defaults || value != defaultValue) {
                this.addUint64(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldUint64(voffset: Offset, value: u64, defaultValue: u64): void {
            if (this.force_defaults || value != defaultValue) {
                this.addUint64(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldFloat32(voffset: Offset, value: f32, defaultValue: f32): void {
            if (this.force_defaults || value != defaultValue) {
                this.addFloat64(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldFloat64(voffset: Offset, value: f64, defaultValue: f64): void {
            if (this.force_defaults || value != defaultValue) {
                this.addFloat64(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldOffset(voffset: Offset, value: Offset, defaultValue: Offset): void {
            if (this.force_defaults || value != defaultValue) {
                this.addOffset(value);
                this.slot(voffset);
            }
        }

        @inline
        addFieldStruct(voffset: Offset, value: Offset, defaultValue: Offset): void {
            if (value != defaultValue) {
                this.nested(value);
                this.slot(voffset);
            }
        }

        @inline
        nested(obj: Offset): void {
            if (obj != this.offset()) {
                throw new Error('FlatBuffers: struct must be serialized inline.');
            }
        }

        @inline
        addUint8Vector<T>(value: T): Offset {
            if (value instanceof flatbuffers.ByteString) {
                this.startVector(1, value.length, 1);
                this.bb.writeBytesUnsafe(this.space -= value.length, value.data, value.length);
            } else if (value instanceof Uint8Array) {
                this.startVector(1, value.length, 1);
                let buf = changetype<usize>(value.buffer);
                this.startVector(1, value.byteLength, 1);
                this.bb.writeBytesUnsafe(this.space -= value.length, buf, value.byteLength);
            } else if (value instanceof ArrayBuffer) {
                let buf = changetype<usize>(value);
                let length = value.byteLength;
                this.startVector(1, length, 1);
                this.bb.writeBytesUnsafe(this.space -= length, buf, length);
            } else if (value instanceof String) {
                let encoded = String.UTF8.encode(value.toString());
                this.startVector(1, encoded.byteLength, 1);
                this.bb.writeBytesUnsafe(
                    this.space -= encoded.byteLength,
                    changetype<usize>(encoded),
                    encoded.byteLength
                );
            }
            return this.endVector();
        }
    }

    type Ptr<T> = usize;

    export class ByteBuffer {
        bytes_: Uint8Array;
        position_: u32;
        dataStart_: usize;

        constructor(bytes: Uint8Array, position: u32 = 0) {
            this.bytes_ = bytes;
            this.position_ = position;
            this.dataStart_ = changetype<usize>(bytes.buffer);
        }

        @inline
        static allocate(size: i32): ByteBuffer {
            return new ByteBuffer(new Uint8Array(size), 0);
        }

        @inline
        static of(bytes: Uint8Array, position: u32 = 0): ByteBuffer {
            return new ByteBuffer(bytes, 0);
        }

        @inline
        clear(): void {
            this.position_ = 0;
        }

        @inline
        bytes(): Uint8Array {
            return this.bytes_;
        }

        @inline
        dataStart(): usize {
            return this.dataStart_;
        }

        @inline
        position(): Offset {
            return this.position_;
        }

        @inline
        setPosition(position: Offset): void {
            this.position_ = position;
        }

        @inline
        capacity(): i32 {
            return this.bytes_.byteLength;
        }

        @inline
        readBoolean(offset: Offset): boolean {
            return load<u8>(this.dataStart_ + <usize>offset) != 0;
        }

        @inline
        readInt8(offset: Offset): i8 {
            return load<i8>(this.dataStart_ + <usize>offset);
        }

        @inline
        readUint8(offset: Offset): u8 {
            return load<u8>(this.dataStart_ + <usize>offset);
        }

        @inline
        readInt16(offset: Offset): i16 {
            return load<i16>(this.dataStart_ + <usize>offset);
        }

        @inline
        readUint16(offset: Offset): u16 {
            return load<u16>(this.dataStart_ + <usize>offset);
        }

        @inline
        readInt32(offset: Offset): i32 {
            return load<i32>(this.dataStart_ + <usize>offset);
        }

        @inline
        readUint32(offset: Offset): u32 {
            return load<u32>(this.dataStart_ + <usize>offset);
        }

        @inline
        readInt64(offset: Offset): i64 {
            return load<i64>(this.dataStart_ + <usize>offset);
        }

        @inline
        readUint64(offset: Offset): u64 {
            return load<u64>(this.dataStart_ + <usize>offset);
        }

        @inline
        writeBoolean(offset: Offset, value: boolean): void {
            store<u8>(this.dataStart_ + <usize>offset, value ? 1 : 0);
        }

        @inline
        writeInt8(offset: Offset, value: i8): void {
            store<i8>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeUint8(offset: Offset, value: u8): void {
            store<u8>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeInt16(offset: Offset, value: i16): void {
            // this.bytes_[offset] = <u8>value;
            // this.bytes_[offset + 1] = <u8>(value >> 8);

            store<i16>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeUint16(offset: Offset, value: u16): void {
            store<u16>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeInt32(offset: Offset, value: i32): void {
            store<i32>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeUint32(offset: Offset, value: u32): void {
            store<u32>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeInt64(offset: Offset, value: i64): void {
            store<i64>(this.dataStart_ + <usize>offset, value);
        }

        /**
         *
         * @param offset
         * @param value
         */
        @inline
        writeUint64(offset: Offset, value: u64): void {
            store<u64>(this.dataStart_ + <usize>offset, value);
        }

        /**
         *
         * @param offset
         * @param value
         */
        @inline
        writeFloat32(offset: Offset, value: f32): void {
            store<f32>(this.dataStart_ + <usize>offset, value);
        }

        /**
         *
         * @param offset
         * @param value
         */
        @inline
        writeFloat64(offset: Offset, value: f64): void {
            store<f64>(this.dataStart_ + <usize>offset, value);
        }

        @inline
        writeBytesUnsafe(offset: Offset, src: usize, length: i32): void {
            memory.copy(this.dataStart_ + <usize>offset, src, <usize>length);
        }

        /**
         * Return the file identifier.   Behavior is undefined for FlatBuffers whose
         * schema does not include a file_identifier (likely points at padding or the
         * start of a the root vtable).
         * @returns {string}
         */
        getBufferIdentifier(): string {
            if (this.bytes_.length < this.position_ + SIZEOF_INT + FILE_IDENTIFIER_LENGTH) {
                throw new Error(
                    'FlatBuffers: ByteBuffer is too short to contain an identifier.');
            }

            let result = "";
            for (let i = 0; i < FILE_IDENTIFIER_LENGTH; i++) {
                result += String.fromCharCode(
                    this.readInt8(this.position_ + SIZEOF_INT + i));
            }
            return result;
        }

        /**
         * Look up a field in the vtable, return an offset into the object, or 0 if the
         * field is not present.
         *
         * @param {number} bb_pos
         * @param {number} vtable_offset
         * @returns {number}
         */
        @inline
        __offset(bb_pos: Offset, vtable_offset: Offset): Offset {
            let vtable = bb_pos - this.readInt32(bb_pos);
            return vtable_offset < this.readInt16(vtable) ? this.readInt16(vtable + vtable_offset) : 0;
        }

        /**
         * Initialize any Table-derived type to point to the union at the given offset.
         *
         * @param {flatbuffers.Table} t
         * @param {number} offset
         * @returns {flatbuffers.Table}
         */
        @inline
        __union<T extends flatbuffers.Table>(t: T, offset: Offset): T {
            t.bb = this;
            t.bb_pos = offset + this.readInt32(offset);
            return t;
        }

        /**
         * Create an AssemblyScript string from UTF-8 data stored inside the FlatBuffer.
         * This allocates a new string and converts to wide chars upon each access.
         *
         * To avoid the conversion to UTF-16, pass flatbuffers.Encoding.UTF8_BYTES as
         * the "optionalEncoding" argument. This is useful for avoiding conversion to
         * and from UTF-16 when the data will just be packaged back up in another
         * FlatBuffer later on.
         *
         * @param {number} offset
         * @param {flatbuffers.Encoding} opt_encoding Defaults to UTF16_STRING
         * @returns {string|!Uint8Array}
         */
        __string(offset: Offset): ByteString {
            let length = this.readInt32(offset);
            // offset += length;
            // offset += SIZEOF_INT;
            return new ByteString(
                changetype<usize>(this.bytes_.buffer) + <usize>(offset + SIZEOF_INT + length),
                length
            );
        }

        __string0(offset: Offset, opt_encoding: Encoding = Encoding.UTF8_BYTES): string {
            let length = this.readInt32(offset);
            offset += length;
            offset += SIZEOF_INT;

            if (opt_encoding == Encoding.UTF8_BYTES) {
                return String.UTF8.decode(this.bytes_.subarray(offset, offset + length).buffer);
            } else {
                return String.UTF16.decode(this.bytes_.subarray(offset, offset + length).buffer);
            }
        }

        /**
         * Handle unions that can contain string as its member, if a Table-derived type then initialize it,
         * if a string then return a new one
         *
         * WARNING: strings are immutable in AssemblyScript so we can't change the string that the user gave us, this
         * makes the behaviour of __union_with_string different compared to __union
         *
         * @param {flatbuffers.Table|string} o
         * @param {number} offset
         * @returns {flatbuffers.Table|string}
         */
        @inline
        __union_with_string<T>(o: T, offset: Offset): T {
            if (o instanceof ByteString) {
                let bs = this.__string(offset);
                // @ts-ignore
                return bs as T;
            } else if (o instanceof Table) {
                return this.__union(o, offset);
            } else {
                throw new Error("__union_with_string passed type that was not a ByteString or extends from Table");
            }
        }

        /**
         * Retrieve the relative offset stored at "offset"
         * @param {Offset} offset
         * @returns {Offset}
         */
        @inline
        __indirect(offset: Offset): Offset {
            return offset + load<i32>(this.dataStart_ + <usize>offset);
        }

        /**
         * Get the start of data of a vector whose offset is stored at "offset" in this object.
         *
         * @param {number} offset
         * @returns {number}
         */
        @inline
        __vector(offset: Offset): Offset {
            return offset + load<i32>(this.dataStart_ + <usize>offset) + SIZEOF_INT;
        }

        /**
         * Get the length of a vector whose offset is stored at "offset" in this object.
         *
         * @param {number} offset
         * @returns {number}
         */
        @inline
        __vector_len(offset: Offset): Offset {
            // readInt32() = load<i32>(this.dataStart_ + <usize>offset);
            return load<i32>(<usize>load<i32>(this.dataStart_ + <usize>offset) + <usize>offset);
            // return this.readInt32(offset + this.readInt32(offset));
        }

        /**
         * @param {string} ident
         * @returns {boolean}
         */
        @inline
        __has_identifier(ident: string): boolean {
            if (ident.length != FILE_IDENTIFIER_LENGTH) {
                throw new Error('FlatBuffers: file identifier must be length ' +
                    flatbuffers.FILE_IDENTIFIER_LENGTH);
            }
            for (let i = 0; i < flatbuffers.FILE_IDENTIFIER_LENGTH; i++) {
                if (ident.charCodeAt(i) != this.readInt8(this.position_ + SIZEOF_INT + i)) {
                    return false;
                }
            }
            return true;
        }
    }

    /**
     * Memory view.
     */
    @unmanaged
    export class ByteString {
        @unsafe readonly data: usize;
        readonly length: i32;

        constructor(data: usize, length: i32) {
            this.data = data;
            this.length = length;
        }

        static readonly NULL: flatbuffers.ByteString = new flatbuffers.ByteString(0, -1);

        equals<T>(to: T): boolean {
            if (to instanceof ByteString) {
                return ByteString.__eq(this, to);
            }

            // Compare as UTF-8
            if (to instanceof String) {
                let str = changetype<usize>(to);
                let len = to.length;
                let strEnd = str + (<usize>len << 1);
                let bufOff = this.data;
                while (str < strEnd) {
                    let c1 = <u32>load<u16>(str);
                    if (c1 < 128) {
                        if (load<u8>(str) != load<u8>(bufOff)) {
                            return false;
                        }
                        bufOff++;
                    } else if (c1 < 2048) {
                        let b0 = c1 >> 6 | 192;
                        let b1 = c1 & 63 | 128;
                        let val = <u16>(b1 << 8 | b0);
                        if (load<u16>(bufOff) != val) {
                            return false;
                        }
                        bufOff += 2;
                    } else {
                        if ((c1 & 0xFC00) == 0xD800 && str + 2 < strEnd) {
                            let c2 = <u32>load<u16>(str, 2);
                            if ((c2 & 0xFC00) == 0xDC00) {
                                c1 = 0x10000 + ((c1 & 0x03FF) << 10) | (c2 & 0x03FF);
                                let b0 = c1 >> 18 | 240;
                                let b1 = c1 >> 12 & 63 | 128;
                                let b2 = c1 >> 6 & 63 | 128;
                                let b3 = c1 & 63 | 128;
                                let val = <u32>(b3 << 24 | b2 << 16 | b1 << 8 | b0);
                                if (load<u32>(bufOff) != val) {
                                    return false;
                                }
                                // store<u32>(bufOff, b3 << 24 | b2 << 16 | b1 << 8 | b0);
                                bufOff += 4;
                                str += 4;
                                continue;
                            }
                        }
                        let b0 = c1 >> 12 | 224;
                        let b1 = c1 >> 6 & 63 | 128;
                        let b2 = c1 & 63 | 128;
                        let val = <u16>(b1 << 8 | b0);
                        if (load<u16>(bufOff) != val) {
                            return false;
                        }
                        if (load<u8>(bufOff, 2) != b2) {
                            return false;
                        }
                        // store<u16>(bufOff, b1 << 8 | b0);
                        // store<u8>(bufOff, b2, 2);
                        bufOff += 3;
                    }
                    str += 2;
                }
                return true;
            }

            if (to instanceof ArrayBuffer) {
                return ByteString._compareUnsafe(
                    this.data, this.length, changetype<usize>(to), to.byteLength) == 0;
            }

            if (to instanceof Uint8Array) {
                return ByteString._compareUnsafe(
                    this.data, this.length, changetype<usize>(to.buffer), to.byteLength) == 0;
            }

            return false;
        }

        @inline
        equalsUTF16(to: string): boolean {
            if (to == null) return false;
            let str = changetype<usize>(to);
            let len = to.length * 2;
            if (this.length != len || this.length == 0) return false;
            return memory.compare(this.data, str, len) == 0;
        }

        @inline
        private static _compare(left: ByteString, right: ByteString): i32 {
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length);
        }

        @inline
        private static _compareUnsafe(left: usize, leftLength: i32, right: usize, rightLength: i32): i32 {
            if (leftLength == -1) {
                return rightLength == -1 ? 0 : -1;
            }
            if (rightLength == -1) {
                return 1;
            }
            if (leftLength < rightLength) {
                let res = memory.compare(left, right, <usize>leftLength);
                if (res == 0) return -1;
                return res;
            } else if (leftLength > rightLength) {
                let res = memory.compare(left, right, <usize>rightLength);
                if (res == 0) return 1;
                return res;
            } else {
                return memory.compare(left, right, <usize>leftLength);
            }
        }

        @inline @operator("==")
        private static __eq(left: ByteString | null, right: ByteString | null): boolean {
            if (left === right) return true;
            if (left === null || right === null) return false;
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length) == 0;
        }

        @inline @operator("%")
        private static __eqStr(left: ByteString | null, right: string | null): boolean {
            if (left === null || right === null) return false;
            return left.equals(right);
        }

        @inline @operator("!=")
        private static __notEq(left: ByteString | null, right: ByteString | null): boolean {
            return !ByteString.__eq(left, right);
        }

        @inline @operator.prefix("!")
        private static __not(to: ByteString | null): boolean {
            return to === null || to.length == -1;
        }

        @inline @operator("<")
        private static __lt(left: ByteString | null, right: ByteString | null): boolean {
            if (left === right) return false;
            if (left === null || right === null) return false;
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length) < 0;
        }

        @inline @operator("<=")
        private __lte(left: ByteString | null, right: ByteString | null): boolean {
            if (left === right) return true;
            if (left === null || right === null) return false;
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length) < 0;
        }

        @inline @operator(">")
        private static __gt(left: ByteString | null, right: ByteString | null): boolean {
            if (left === right) return false;
            if (left === null || right === null) return false;
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length) > 0;
        }

        @inline @operator(">=")
        private static __gte(left: ByteString | null, right: ByteString | null): boolean {
            if (left === right) return true;
            if (left === null || right === null) return false;
            return ByteString._compareUnsafe(left.data, left.length, right.data, right.length) > 0;
        }

        @inline
        toString(): string {
            return String.UTF8.decodeUnsafe(this.data, this.length);
        }

        @inline
        toStringUTF16(): string {
            return String.UTF16.decodeUnsafe(this.data, this.length);
        }

        @inline
        toUint8Array(): Uint8Array {
            let arr = new Uint8Array(this.length);
            let buf = changetype<usize>(arr.buffer);
            memory.copy(buf, this.data, this.length);
            return arr;
        }

        @inline
        toArrayBuffer(): ArrayBuffer {
            let arr = new ArrayBuffer(this.length);
            let buf = changetype<usize>(arr);
            memory.copy(buf, this.data, this.length);
            return arr;
        }

        @inline
        isNull(): boolean {
            return this.length == -1;
        }

        @inline
        isNullOrEmpty(): boolean {
            return this.length < 1;
        }
    }

    export class Utf8String {
        private static interns: Map<string, flatbuffers.Utf8String> = new Map<string, flatbuffers.Utf8String>();

        str: string;
        buffer: ArrayBuffer;
        bytes: ByteString;

        constructor(str: string, buffer: ArrayBuffer) {
            this.str = str;
            this.buffer = buffer;
            this.bytes = new ByteString(changetype<usize>(buffer), buffer.byteLength);
        }

        @inline
        static of(str: string): Utf8String {
            return new Utf8String(str, String.UTF8.encode(str));
        }

        @inline
        static intern(str: string): ByteString {
            let v = Utf8String.interns.get(str);
            if (!v) {
                v = Utf8String.of(str);
                Utf8String.interns.set(str, v);
            }
            return v.bytes;
        }
    }

    // @ts-ignore
    @inline
    export function utf8(str: string): Utf8String {
        return Utf8String.of(str);
    }

    // @ts-ignore
    @inline
    export function intern(str: string): ByteString {
        return Utf8String.intern(str);
    }

    // @ts-ignore
    @inline
    export function builder(initialSize: i32 = 128): Builder {
        return new Builder(initialSize);
    }

    // @ts-ignore
    @inline
    export function buffer(size: i32): ByteBuffer {
        return ByteBuffer.allocate(size);
    }

    // @ts-ignore
    @inline
    export function wrap(buffer: ArrayBuffer, position: i32 = 0): ByteBuffer {
        return ByteBuffer.of(Uint8Array.wrap(buffer, 0), 0);
    }
}
