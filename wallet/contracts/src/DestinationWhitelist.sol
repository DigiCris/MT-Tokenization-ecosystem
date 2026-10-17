// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IDestinationWhitelist} from "./interfaces/IDestinationWhitelist.sol";

/// @title DestinationWhitelist
/// @notice Whitelist on-chain de destinos de salida por Safe ([C-WHL-01..03], ADR-006).
/// @dev Cada Safe sólo administra su propia lista (`msg.sender` es la clave): en el camino asistido el
///      alta exige una SafeTx U+S validada por el Guard ([C-GRD-10]), así que el backend solo no puede
///      alterarla (A18). Las altas se activan 24 h después; las bajas son inmediatas.
contract DestinationWhitelist is IDestinationWhitelist {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @inheritdoc IDestinationWhitelist
    uint256 public constant ACTIVATION_DELAY = 24 hours;

    mapping(address safe => EnumerableSet.AddressSet) private _destinations;
    mapping(address safe => mapping(address destination => uint64)) private _activatesAt;

    /// @notice Alta de un destino; queda activo desde `activatesAt`.
    event DestinationAdded(address indexed safe, address indexed destination, uint64 activatesAt);
    /// @notice Baja inmediata de un destino.
    event DestinationRemoved(address indexed safe, address indexed destination);

    /// @notice `destination` es `address(0)` o la propia Safe.
    error InvalidDestination();
    /// @notice El destino ya está en la lista (activo o pendiente).
    error AlreadyWhitelisted();
    /// @notice El destino no está en la lista.
    error NotWhitelisted();

    /// @inheritdoc IDestinationWhitelist
    function addDestination(address destination) external {
        if (destination == address(0) || destination == msg.sender) revert InvalidDestination();
        if (!_destinations[msg.sender].add(destination)) revert AlreadyWhitelisted();
        // uint64 de segundos alcanza hasta el año 584.942.417.355; block.timestamp + demora nunca lo excede.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 activatesAt = uint64(block.timestamp + ACTIVATION_DELAY);
        _activatesAt[msg.sender][destination] = activatesAt;
        emit DestinationAdded(msg.sender, destination, activatesAt);
    }

    /// @inheritdoc IDestinationWhitelist
    function removeDestination(address destination) external {
        if (!_destinations[msg.sender].remove(destination)) revert NotWhitelisted();
        delete _activatesAt[msg.sender][destination];
        emit DestinationRemoved(msg.sender, destination);
    }

    /// @inheritdoc IDestinationWhitelist
    function isWhitelisted(address safe, address destination) external view returns (bool) {
        // el timelock compara contra block.timestamp por diseño; los validadores sólo lo desplazan segundos frente a demoras de horas.
        // forge-lint: disable-next-line(block-timestamp)
        return _destinations[safe].contains(destination) && block.timestamp >= _activatesAt[safe][destination];
    }

    /// @inheritdoc IDestinationWhitelist
    function destinationsOf(address safe) external view returns (address[] memory) {
        return _destinations[safe].values();
    }

    /// @inheritdoc IDestinationWhitelist
    function destinationInfo(address safe, address destination)
        external
        view
        returns (bool exists, uint64 activatesAt, bool active)
    {
        exists = _destinations[safe].contains(destination);
        activatesAt = _activatesAt[safe][destination];
        // el timelock compara contra block.timestamp por diseño; los validadores sólo lo desplazan segundos frente a demoras de horas.
        // forge-lint: disable-next-line(block-timestamp)
        active = exists && block.timestamp >= activatesAt;
    }
}
