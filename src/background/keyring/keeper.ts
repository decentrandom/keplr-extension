import {
  Key,
  KeyRing,
  KeyRingStatus,
  MultiKeyStoreInfoWithSelected
} from "./keyring";

import { Address } from "@chainapsis/cosmosjs/crypto";
import { AsyncApprover } from "../../common/async-approver";
import {
  BIP44HDPath,
  SelectableAccount,
  TxBuilderConfigPrimitive,
  TxBuilderConfigPrimitiveWithChainId
} from "./types";

import { KVStore } from "../../common/kvstore";

import { ChainsKeeper } from "../chains/keeper";
import { LedgerKeeper } from "../ledger/keeper";
import { BIP44 } from "@chainapsis/cosmosjs/core/bip44";
import Axios from "axios";
import { AccAddress } from "@chainapsis/cosmosjs/common/address";
import { ChainInfo } from "../chains";
import { BaseAccount } from "@chainapsis/cosmosjs/common/baseAccount";

export interface KeyHex {
  algo: string;
  pubKeyHex: string;
  addressHex: string;
  bech32Address: string;
}

interface SignMessage {
  chainId: string;
  message: Uint8Array;
}

export class KeyRingKeeper {
  private readonly keyRing: KeyRing;

  private readonly unlockApprover: AsyncApprover;

  private readonly txBuilderApprover: AsyncApprover<
    TxBuilderConfigPrimitiveWithChainId,
    TxBuilderConfigPrimitive
  >;

  private readonly signApprover: AsyncApprover<SignMessage>;

  constructor(
    embedChainInfos: ChainInfo[],
    kvStore: KVStore,
    public readonly chainsKeeper: ChainsKeeper,
    ledgerKeeper: LedgerKeeper,
    private readonly windowOpener: (url: string) => void,
    approverTimeout: number | undefined = undefined
  ) {
    this.keyRing = new KeyRing(embedChainInfos, kvStore, ledgerKeeper);

    this.unlockApprover = new AsyncApprover({
      defaultTimeout: approverTimeout != null ? approverTimeout : 3 * 60 * 1000
    });
    this.txBuilderApprover = new AsyncApprover<
      TxBuilderConfigPrimitiveWithChainId,
      TxBuilderConfigPrimitive
    >({
      defaultTimeout: approverTimeout != null ? approverTimeout : 3 * 60 * 1000
    });
    this.signApprover = new AsyncApprover<SignMessage>({
      defaultTimeout: approverTimeout != null ? approverTimeout : 3 * 60 * 1000
    });
  }

  async enable(extensionBaseURL: string): Promise<KeyRingStatus> {
    if (this.keyRing.status === KeyRingStatus.EMPTY) {
      throw new Error("key doesn't exist");
    }

    if (this.keyRing.status === KeyRingStatus.NOTLOADED) {
      await this.keyRing.restore();
    }

    if (this.keyRing.status === KeyRingStatus.LOCKED) {
      this.windowOpener(`${extensionBaseURL}popup.html#/?external=true`);
      await this.unlockApprover.request("unlock");
      return this.keyRing.status;
    }

    return this.keyRing.status;
  }

  get keyRingStatus(): KeyRingStatus {
    return this.keyRing.status;
  }

  async checkAccessOrigin(
    extensionBaseURL: string,
    chainId: string,
    origin: string
  ) {
    await this.chainsKeeper.checkAccessOrigin(
      extensionBaseURL,
      chainId,
      origin
    );
  }

  async checkBech32Address(chainId: string, bech32Address: string) {
    const key = await this.getKey(chainId);
    if (
      bech32Address !==
      new Address(key.address).toBech32(
        (await this.chainsKeeper.getChainInfo(chainId)).bech32Config
          .bech32PrefixAccAddr
      )
    ) {
      throw new Error("Invalid bech32 address");
    }
  }

  async restore(): Promise<KeyRingStatus> {
    await this.keyRing.restore();
    return this.keyRing.status;
  }

  async save(): Promise<void> {
    await this.keyRing.save();
  }

  async deleteKeyRing(
    index: number,
    password: string
  ): Promise<{
    multiKeyStoreInfo: MultiKeyStoreInfoWithSelected;
    status: KeyRingStatus;
  }> {
    const multiKeyStoreInfo = await this.keyRing.deleteKeyRing(index, password);
    return {
      multiKeyStoreInfo,
      status: this.keyRing.status
    };
  }

  async showKeyRing(index: number, password: string): Promise<string> {
    return await this.keyRing.showKeyRing(index, password);
  }

  async createMnemonicKey(
    mnemonic: string,
    password: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<KeyRingStatus> {
    // TODO: Check mnemonic checksum.
    await this.keyRing.createMnemonicKey(mnemonic, password, meta, bip44HDPath);
    return this.keyRing.status;
  }

  async createPrivateKey(
    privateKey: Uint8Array,
    password: string,
    meta: Record<string, string>
  ): Promise<KeyRingStatus> {
    // TODO: Check mnemonic checksum.
    await this.keyRing.createPrivateKey(privateKey, password, meta);
    return this.keyRing.status;
  }

  async createLedgerKey(
    password: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<KeyRingStatus> {
    await this.keyRing.createLedgerKey(password, meta, bip44HDPath);
    return this.keyRing.status;
  }

  lock(): KeyRingStatus {
    this.keyRing.lock();
    return this.keyRing.status;
  }

  async unlock(password: string): Promise<KeyRingStatus> {
    await this.keyRing.unlock(password);
    try {
      this.unlockApprover.approve("unlock");
    } catch {
      // noop
    }

    return this.keyRing.status;
  }

  async getKey(chainId: string): Promise<Key> {
    return this.keyRing.getKey(
      chainId,
      await this.chainsKeeper.getChainCoinType(chainId)
    );
  }

  async requestTxBuilderConfig(
    extensionBaseURL: string,
    config: TxBuilderConfigPrimitiveWithChainId,
    id: string,
    openPopup: boolean,
    skipApprove: boolean
  ): Promise<TxBuilderConfigPrimitive> {
    if (skipApprove) {
      return config;
    }

    if (openPopup) {
      this.windowOpener(
        `${extensionBaseURL}popup.html#/fee/${id}?external=true`
      );
    }

    const result = await this.txBuilderApprover.request(id, config);
    if (!result) {
      throw new Error("config is approved, but result config is null");
    }
    return result;
  }

  getRequestedTxConfig(id: string): TxBuilderConfigPrimitiveWithChainId {
    const config = this.txBuilderApprover.getData(id);
    if (!config) {
      throw new Error("Unknown config request id");
    }

    return config;
  }

  approveTxBuilderConfig(id: string, config: TxBuilderConfigPrimitive) {
    this.txBuilderApprover.approve(id, config);
  }

  rejectTxBuilderConfig(id: string): void {
    this.txBuilderApprover.reject(id);
  }

  getKeyRingType(): string {
    return this.keyRing.type;
  }

  async requestSign(
    extensionBaseURL: string,
    chainId: string,
    message: Uint8Array,
    id: string,
    openPopup: boolean,
    skipApprove: boolean
  ): Promise<Uint8Array> {
    if (skipApprove) {
      return await this.keyRing.sign(
        chainId,
        await this.chainsKeeper.getChainCoinType(chainId),
        message
      );
    }

    if (openPopup) {
      this.windowOpener(
        `${extensionBaseURL}popup.html#/sign/${id}?external=true`
      );
    }

    await this.signApprover.request(id, { chainId, message });
    return await this.keyRing.sign(
      chainId,
      await this.chainsKeeper.getChainCoinType(chainId),
      message
    );
  }

  getRequestedMessage(id: string): SignMessage {
    const message = this.signApprover.getData(id);
    if (!message) {
      throw new Error("Unknown sign request id");
    }

    return message;
  }

  approveSign(id: string): void {
    this.signApprover.approve(id);
  }

  rejectSign(id: string): void {
    this.signApprover.reject(id);
  }

  async sign(chainId: string, message: Uint8Array): Promise<Uint8Array> {
    return this.keyRing.sign(
      chainId,
      await this.chainsKeeper.getChainCoinType(chainId),
      message
    );
  }

  async addMnemonicKey(
    mnemonic: string,
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<MultiKeyStoreInfoWithSelected> {
    return this.keyRing.addMnemonicKey(mnemonic, meta, bip44HDPath);
  }

  async addPrivateKey(
    privateKey: Uint8Array,
    meta: Record<string, string>
  ): Promise<MultiKeyStoreInfoWithSelected> {
    return this.keyRing.addPrivateKey(privateKey, meta);
  }

  async addLedgerKey(
    meta: Record<string, string>,
    bip44HDPath: BIP44HDPath
  ): Promise<MultiKeyStoreInfoWithSelected> {
    return this.keyRing.addLedgerKey(meta, bip44HDPath);
  }

  public async changeKeyStoreFromMultiKeyStore(
    index: number
  ): Promise<MultiKeyStoreInfoWithSelected> {
    return this.keyRing.changeKeyStoreFromMultiKeyStore(index);
  }

  getMultiKeyStoreInfo(): MultiKeyStoreInfoWithSelected {
    return this.keyRing.getMultiKeyStoreInfo();
  }

  setKeyStoreCoinType(chainId: string, coinType: number): void {
    this.keyRing.setKeyStoreCoinType(chainId, coinType);
  }

  async getKeyStoreBIP44Selectables(
    chainId: string,
    paths: BIP44[]
  ): Promise<SelectableAccount[]> {
    // If keystore already has the coin type, return empty array.
    if (this.keyRing.getKeyStoreCoinType(chainId) !== undefined) {
      return [];
    }

    const chainInfo = await this.chainsKeeper.getChainInfo(chainId);

    const restInstance = Axios.create({
      ...{
        baseURL: chainInfo.rest
      },
      ...chainInfo.restConfig
    });

    const accounts: SelectableAccount[] = [];

    for (const path of paths) {
      const key = await this.keyRing.getKeyFromCoinType(path.coinType);
      const bech32Address = new AccAddress(
        key.address,
        chainInfo.bech32Config.bech32PrefixAccAddr
      ).toBech32();

      try {
        const result = await restInstance.get(
          `/auth/accounts/${bech32Address}`
        );

        if (result.status === 200) {
          const baseAccount = BaseAccount.fromJSON(result.data);
          accounts.push({
            path,
            bech32Address,
            isExistent: true,
            sequence: baseAccount.getSequence().toString(),
            // TODO: If the chain is stargate, this will return empty array because the balances doens't exist on the account itself.
            coins: baseAccount.getCoins().map(coin => {
              return {
                denom: coin.denom,
                amount: coin.amount.toString()
              };
            })
          });
        } else {
          accounts.push({
            path,
            bech32Address,
            isExistent: false,
            sequence: "0",
            coins: []
          });
        }
      } catch (e) {
        accounts.push({
          path,
          bech32Address,
          isExistent: false,
          sequence: "0",
          coins: []
        });
        console.log(`Failed to fetch account: ${e.message}`);
      }
    }

    return accounts;
  }
}
