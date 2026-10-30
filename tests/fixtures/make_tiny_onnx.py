#!/usr/bin/env python3
"""Write tests/fixtures/tiny_matmul.onnx without the onnx package: Y = MatMul(X, W) + B, X float32 [N, 4] (N is a
named, flexible batch dimension), W [4, 3], B [3]. Encodes the ONNX protobuf directly."""
import os
import struct


def varint(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def key(field, wire):
    return varint((field << 3) | wire)


def vint(field, n):
    return key(field, 0) + varint(n)


def ld(field, payload):
    if isinstance(payload, str):
        payload = payload.encode()
    return key(field, 2) + varint(len(payload)) + payload


def tensor(name, dims, values):  # TensorProto, float32, raw_data
    return b''.join(vint(1, d) for d in dims) + vint(2, 1) + ld(8, name) + ld(9, struct.pack('<%df' % len(values), *values))


def value_info(name, dims):  # dims: ints, or strings for named (flexible) dimensions
    dim = b''.join(ld(1, vint(1, d) if isinstance(d, int) else ld(2, d)) for d in dims)
    tensor_type = vint(1, 1) + ld(2, dim)
    return ld(1, name) + ld(2, ld(1, tensor_type))


def node(op, inputs, outputs, name):
    return b''.join(ld(1, i) for i in inputs) + b''.join(ld(2, o) for o in outputs) + ld(3, name) + ld(4, op)


W = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]          # rows: x0→y0, x1→y1, x2→y2, x3→all
B = [0.5, -1, 10]
graph = (ld(1, node('MatMul', ['X', 'W'], ['XW'], 'mm')) + ld(1, node('Add', ['XW', 'B'], ['Y'], 'add')) + ld(2, 'tiny')
         + ld(5, tensor('W', [4, 3], W)) + ld(5, tensor('B', [3], B))
         + ld(11, value_info('X', ['N', 4])) + ld(12, value_info('Y', ['N', 3])))
model = vint(1, 8) + ld(2, 'jade-test') + ld(7, graph) + ld(8, ld(1, '') + vint(2, 13))
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tiny_matmul.onnx')
open(out, 'wb').write(model)
print(out, len(model), 'bytes')
