// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Minimal ERC-721 sample for PalletDock indexing tests.
/// Anyone may mint the next token id to any address; this is a test fixture, not a production NFT contract.
contract PalletDockCollectible is ERC721 {
    uint256 public nextTokenId;

    constructor() ERC721("PalletDock Test Collectible", "PDTC") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
    }
}
