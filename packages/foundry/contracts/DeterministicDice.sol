// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title DeterministicDice — Solidity port of github.com/austintgriffith/deterministic-dice
/// @notice Nibble-by-nibble consumption with unbiased rejection sampling.
///         Uses keccak256 for rehashing — matches the noble/hashes keccak_256 used in the TS lib.
///         Same seed always produces the same sequence.
library DeterministicDice {
    struct State {
        bytes32 entropy;
        uint256 position; // nibble index into entropy (0-63)
    }

    /// @notice Create a new dice state from a seed
    function create(bytes32 seed) internal pure returns (State memory s) {
        s.entropy = seed;
        s.position = 0;
    }

    /// @notice Roll for a value in [0, n). Matches TypeScript roll(n) exactly.
    /// @dev Uses unbiased rejection sampling to avoid modulo bias.
    function roll(State memory s, uint256 n) internal pure returns (uint256) {
        require(n > 0, "DeterministicDice: n must be > 0");

        uint256 bitsNeeded    = _ceilLog2(n);
        uint256 hexNeeded     = bitsNeeded == 0 ? 1 : (bitsNeeded + 3) / 4;
        if (hexNeeded == 0) hexNeeded = 1;

        uint256 maxValue  = _pow16(hexNeeded); // 16^hexNeeded
        uint256 threshold = maxValue - (maxValue % n);

        uint256 value;
        do {
            value = _consumeHex(s, hexNeeded);
        } while (value >= threshold);

        return value % n;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _consumeHex(State memory s, uint256 count) private pure returns (uint256 result) {
        result = 0;
        for (uint256 i = 0; i < count; i++) {
            if (s.position >= 64) {
                // Rehash: keccak256 of the raw 32 entropy bytes — matches keccak_256(hexToBytes(entropy))
                s.entropy  = keccak256(abi.encodePacked(s.entropy));
                s.position = 0;
            }
            uint256 nibble = _getNibble(s.entropy, s.position);
            result = (result << 4) | nibble;
            s.position++;
        }
    }

    /// @dev Extract nibble at `pos` (0 = most-significant nibble of byte 0).
    function _getNibble(bytes32 data, uint256 pos) private pure returns (uint256) {
        uint256 byteIndex = pos >> 1; // pos / 2
        uint8   b         = uint8(data[byteIndex]);
        if (pos & 1 == 0) {
            return (b >> 4) & 0xF; // high nibble
        } else {
            return b & 0xF;        // low nibble
        }
    }

    /// @dev Ceiling of log2(n). Returns 0 for n==1.
    function _ceilLog2(uint256 n) private pure returns (uint256) {
        if (n <= 1) return 0;
        uint256 result = 0;
        uint256 x      = n - 1;
        while (x > 0) {
            result++;
            x >>= 1;
        }
        return result;
    }

    /// @dev 16^exp (small values only — max hexNeeded is ~16 for any realistic n)
    function _pow16(uint256 exp) private pure returns (uint256 result) {
        result = 1;
        for (uint256 i = 0; i < exp; i++) {
            result *= 16;
        }
    }
}
