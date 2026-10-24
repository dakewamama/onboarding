import assert from "node:assert/strict";
import {Keypair} from "@solana/web3.js";
import {squadsControlStatus} from "../payments/src/squads";
describe("squads control config",()=>{
 it("is disabled unless explicitly enabled",()=>{assert.deepEqual(squadsControlStatus({}),{configured:false});});
 it("fails closed when enabled without addresses",()=>{assert.throws(()=>squadsControlStatus({AXIS_SQUADS_ENABLED:"true"}),/AXIS_SQUADS_MULTISIG/);});
 it("accepts explicit addresses",()=>{const multisig=Keypair.generate().publicKey.toBase58();const vault=Keypair.generate().publicKey.toBase58();const executor=Keypair.generate().publicKey.toBase58();assert.deepEqual(squadsControlStatus({AXIS_SQUADS_ENABLED:"true",AXIS_SQUADS_MULTISIG:multisig,AXIS_SQUADS_VAULT:vault,AXIS_SQUADS_EXECUTOR:executor,AXIS_SQUADS_VAULT_INDEX:"0"}),{configured:true,multisig,vault,executor,vaultIndex:0});});
});
