// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title IDestinationWhitelist
/// @notice Whitelist on-chain de destinos por Safe con activación diferida ([C-WHL-01..03]).
interface IDestinationWhitelist {
    function ACTIVATION_DELAY() external view returns (uint256);
    function addDestination(address destination) external;
    function removeDestination(address destination) external;
    function isWhitelisted(address safe, address destination) external view returns (bool);
    function destinationsOf(address safe) external view returns (address[] memory);
    function destinationInfo(address safe, address destination)
        external
        view
        returns (bool exists, uint64 activatesAt, bool active);
}
