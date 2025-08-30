'use server';

import { ID, Query } from "node-appwrite";
import { createAdminClient, createSessionClient } from "../appwrite";
import { cookies } from "next/headers";
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";

import { plaidClient } from '@/lib/plaid';
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env || {};

/* -------------------------
  Helpers: env splitters
   ------------------------- */
const getProducts = (): string[] => {
  if (process.env.PLAID_PRODUCTS) {
    return process.env.PLAID_PRODUCTS.split(',').map(s => s.trim());
  }
  return ['auth'];
};

const getCountryCodes = (): string[] => {
  if (process.env.PLAID_COUNTRY_CODES) {
    return process.env.PLAID_COUNTRY_CODES.split(',').map(s => s.trim());
  }
  return ['US'];
};

/* -------------------------
  User / Auth utilities
   ------------------------- */
export const getUserInfo = async (args: any) => {
  const userId = args?.userId;
  try {
    const { database } = await createAdminClient();
    const user = await database.listDocuments(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      [Query.equal('userId', [userId])]
    );
    return parseStringify(user.documents?.[0] ?? null);
  } catch (error) {
    console.error("getUserInfo error:", error);
    return null;
  }
};

export const signIn = async ({ email, password }: any) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createEmailPasswordSession(email, password);

    cookies().set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    const user = await getUserInfo({ userId: session.userId });
    return parseStringify(user);
  } catch (error) {
    console.error("signIn Error:", error);
    return null;
  }
};

export const signUp = async (args: any) => {
  const { password, email, firstName, lastName, ...rest } = args;
  try {
    const { account, database } = await createAdminClient();
    const newUserAccount = await account.create(ID.unique(), email, password, `${firstName} ${lastName}`);
    if (!newUserAccount) throw new Error("Failed to create user account");

    // create dwolla customer (keeps your existing workflow)
    const dwollaCustomerUrl = await createDwollaCustomer({ ...args, type: 'personal' });
    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

    const newUser = await database.createDocument(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      ID.unique(),
      {
        ...rest,
        email,
        firstName,
        lastName,
        userId: newUserAccount.$id,
        dwollaCustomerId,
        dwollaCustomerUrl,
      }
    );

    const session = await account.createEmailPasswordSession(email, password);
    cookies().set("appwrite-session", session.secret, { path: "/", httpOnly: true, sameSite: "strict", secure: true });

    return parseStringify(newUser);
  } catch (error) {
    console.error("signUp Error:", error);
    return null;
  }
};

export async function getLoggedInUser() {
  try {
    const { account } = await createSessionClient();
    const result = await account.get();
    const user = await getUserInfo({ userId: result.$id });
    return parseStringify(user);
  } catch (error) {
    console.error("getLoggedInUser error:", error);
    return null;
  }
}

export const logoutAccount = async () => {
  try {
    const { account } = await createSessionClient();
    cookies().delete("appwrite-session");
    await account.deleteSession("current");
    return true;
  } catch (error) {
    console.error("logoutAccount error:", error);
    return null;
  }
};

/* -------------------------
  Plaid: create link token
   ------------------------- */
export const createLinkToken = async (user: any) => {
  try {
    const clientUserId = user?.$id || user?.userId || `anon_${Math.random().toString(36).slice(2, 8)}`;

    const tokenParams = {
      user: { client_user_id: clientUserId },
      client_name: `${user?.firstName || "User"} ${user?.lastName || ""}`.trim(),
      products: getProducts(),
      language: "en",
      country_codes: getCountryCodes(),
    };

    console.log("🔵 createLinkToken - params:", { clientUserId, products: tokenParams.products, country_codes: tokenParams.country_codes });

    const response = await plaidClient.linkTokenCreate(tokenParams as any);
    console.log("✅ createLinkToken - link token received");
    return parseStringify({ linkToken: response.data.link_token });
  } catch (error: any) {
    console.error("❌ createLinkToken error:", error?.response?.data || error?.message || error);
    return parseStringify({ error: true, message: error?.response?.data || error?.message || "Failed to create link token" });
  }
};

/* -------------------------
  Save bank account to DB
   ------------------------- */
export const createBankAccount = async (payload: any) => {
  try {
    const { userId, bankId, accountId, accessToken, fundingSourceUrl, shareableId } = payload;
    const { database } = await createAdminClient();
    const bankAccount = await database.createDocument(DATABASE_ID!, BANK_COLLECTION_ID!, ID.unique(), {
      userId, bankId, accountId, accessToken, fundingSourceUrl, shareableId
    });
    console.log("✅ createBankAccount - saved id:", bankAccount.$id);
    return parseStringify(bankAccount);
  } catch (error) {
    console.error("createBankAccount error:", error);
    return null;
  }
};

/* -------------------------
  Plaid: exchange public token
   ------------------------- */
export const exchangePublicToken = async ({ publicToken, user }: any) => {
  try {
    console.log("🔵 exchangePublicToken - starting for user:", user?.$id);

    const exchangeResp = await plaidClient.itemPublicTokenExchange({ public_token: publicToken } as any);
    console.log("✅ itemPublicTokenExchange response:", exchangeResp.data);

    const accessToken = exchangeResp.data?.access_token;
    const itemId = exchangeResp.data?.item_id;

    if (!accessToken || !itemId) {
      console.error("Missing accessToken or itemId:", exchangeResp.data);
      return parseStringify({ error: true, message: "No access token returned from Plaid" });
    }

    // fetch accounts
    const accountsResp = await plaidClient.accountsGet({ access_token: accessToken } as any);
    const accounts = accountsResp.data?.accounts || [];
    console.log("✅ accountsGet count:", accounts.length);

    const accountData = accounts[0];
    if (!accountData) {
      console.warn("No account data returned from Plaid for item:", itemId);
    }

    // create processor token (for Dwolla)
    const processorResp = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountData?.account_id,
      processor: "dwolla"
    } as any);
    const processorToken = processorResp.data?.processor_token;
    console.log("✅ processor token created:", !!processorToken);

    if (!processorToken) {
      return parseStringify({ error: true, message: "Processor token creation failed" });
    }

    // create funding source in Dwolla
    const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: user?.dwollaCustomerId,
      processorToken,
      bankName: accountData?.name,
    });

    if (!fundingSourceUrl) {
      console.error("addFundingSource failed");
      return parseStringify({ error: true, message: "Failed to create Dwolla funding source" });
    }
    console.log("✅ addFundingSource result:", fundingSourceUrl);

    // persist bank
    const saved = await createBankAccount({
      userId: user.$id,
      bankId: itemId,
      accountId: accountData?.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData?.account_id || "")
    });

    console.log("✅ exchangePublicToken - saved bank:", saved?.$id || saved);

    try { revalidatePath("/"); } catch (rerr) { console.warn("revalidatePath warning:", rerr); }

    return parseStringify({
      ok: true,
      itemId,
      accounts,
      fundingSourceUrl,
      savedBankId: saved?.$id || null,
    });
  } catch (error: any) {
    console.error("❌ exchangePublicToken error:", error?.response?.data || error?.message || error);
    return parseStringify({ error: true, message: error?.response?.data || error?.message || "Failed to exchange public token" });
  }
};

/* -------------------------
  Bank retrieval helpers
   ------------------------- */
export const getBanks = async ({ userId }: any) => {
  try {
    const { database } = await createAdminClient();
    const banks = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [Query.equal('userId', [userId])]);
    return parseStringify(banks.documents || []);
  } catch (error) {
    console.error("getBanks error:", error);
    return [];
  }
};

export const getBank = async ({ documentId }: any) => {
  try {
    const { database } = await createAdminClient();
    const bank = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [Query.equal('$id', [documentId])]);
    return parseStringify(bank.documents?.[0] ?? null);
  } catch (error) {
    console.error("getBank error:", error);
    return null;
  }
};

export const getBankByAccountId = async ({ accountId }: any) => {
  try {
    const { database } = await createAdminClient();
    const bank = await database.listDocuments(DATABASE_ID!, BANK_COLLECTION_ID!, [Query.equal('accountId', [accountId])]);
    if ((bank?.total ?? 0) !== 1) return null;
    return parseStringify(bank.documents?.[0] ?? null);
  } catch (error) {
    console.error("getBankByAccountId error:", error);
    return null;
  }
};
