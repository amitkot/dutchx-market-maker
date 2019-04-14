const fs = require('fs')
const path = require('path')
const solc = require('solc')

const contractPath = path.join(__dirname, '../../contracts/')
const dxContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/dx-contracts/contracts/'
)
const dxContractsBasePath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/dx-contracts/contracts/base/'
)
const owlContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/owl-token/contracts/'
)
const dxUtilContractsPath = path.join(
  contractPath,
  '../node_modules/@gnosis.pm/util-contracts/contracts/'
)

const SOURCES = {
  'ERC20Interface.sol': {
    content: fs.readFileSync(contractPath + 'ERC20Interface.sol', 'utf8')
  },
  'ERC20WithSymbol.sol': {
    content: fs.readFileSync(contractPath + 'ERC20Interface.sol', 'utf8')
  },
  'PermissionGroups.sol': {
    content: fs.readFileSync(contractPath + 'PermissionGroups.sol', 'utf8')
  },
  'Withdrawable.sol': {
    content: fs.readFileSync(contractPath + 'Withdrawable.sol', 'utf8')
  },
  'KyberDxMarketMaker.sol': {
    content: fs.readFileSync(contractPath + 'KyberDxMarketMaker.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Math.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Math.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Proxy.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Proxy.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/TokenFRT.sol': {
    content: fs.readFileSync(dxContractsPath + 'TokenFRT.sol', 'utf8')
  },
  '@gnosis.pm/owl-token/contracts/TokenOWL.sol': {
    content: fs.readFileSync(owlContractsPath + 'TokenOWL.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/Token.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'Token.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/SafeTransfer.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'SafeTransfer.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/TokenWhitelist.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'TokenWhitelist.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/DxMath.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'DxMath.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSAuth.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSAuth.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSMath.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSMath.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSNote.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSNote.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSThing.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSThing.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/DSValue.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/DSValue.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/Medianizer.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/Medianizer.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/PriceFeed.sol': {
    content: fs.readFileSync(dxContractsPath + 'Oracle/PriceFeed.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/Oracle/PriceOracleInterface.sol': {
    content: fs.readFileSync(
      dxContractsPath + 'Oracle/PriceOracleInterface.sol',
      'utf8'
    )
  },
  '@gnosis.pm/dx-contracts/contracts/base/EthOracle.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'EthOracle.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/DxUpgrade.sol': {
    content: fs.readFileSync(dxContractsBasePath + 'DxUpgrade.sol', 'utf8')
  },
  '@gnosis.pm/dx-contracts/contracts/base/AuctioneerManaged.sol': {
    content: fs.readFileSync(
      dxContractsBasePath + 'AuctioneerManaged.sol',
      'utf8'
    )
  },
  '@gnosis.pm/dx-contracts/contracts/DutchExchange.sol': {
    content: fs.readFileSync(dxContractsPath + 'DutchExchange.sol', 'utf8')
  },
  '@gnosis.pm/util-contracts/contracts/GnosisStandardToken.sol': {
    content: fs.readFileSync(
      dxUtilContractsPath + 'GnosisStandardToken.sol',
      'utf8'
    )
  },
  '@gnosis.pm/util-contracts/contracts/EtherToken.sol': {
    content: fs.readFileSync(dxUtilContractsPath + 'EtherToken.sol', 'utf8')
  }
}

const compileSources = () => {
  const input = {
    language: 'Solidity',
    sources: SOURCES,
    settings: {
      optimizer: { enabled: true },
      outputSelection: {
        '*': {
          '*': ['*']
        }
      }
    }
  }

  console.log('starting compilation')

  const output = JSON.parse(solc.compile(JSON.stringify(input)))

  if (output.errors) {
    output.errors.forEach(err => {
      console.log(err.formattedMessage)
    })
  }
  console.log('finished compilation')

  return output
}

module.exports = { compileSources }
