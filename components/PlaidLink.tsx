"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  PlaidLinkOnSuccess,
  PlaidLinkOptions,
  usePlaidLink,
} from "react-plaid-link";
import { useRouter } from "next/navigation";
import {
  createLinkToken,
  exchangePublicToken,
} from "@/lib/actions/user.actions";
import Image from "next/image";

const PlaidLink = ({ user, variant }: PlaidLinkProps) => {
  const router = useRouter();
  const [token, setToken] = useState("");

  useEffect(() => {
    const getLinkToken = async () => {
      try {
        const data = await createLinkToken(user);

        if (!data?.linkToken) {
          console.error("❌ No linkToken returned from API", data);
          return;
        }

        console.log("✅ Got Plaid linkToken:", data.linkToken);
        setToken(data.linkToken);
      } catch (err) {
        console.error("❌ Error creating Plaid link token:", err);
      }
    };

    getLinkToken();
  }, [user]);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token: string) => {
      try {
        console.log("✅ onSuccess - public_token:", public_token);
        await exchangePublicToken({
          publicToken: public_token,
          user,
        });

        router.push("/");
      } catch (err) {
        console.error("❌ Error exchanging public token:", err);
      }
    },
    [user, router]
  );

  const config: PlaidLinkOptions = {
    token,
    onSuccess,
  };

  const { open, ready } = usePlaidLink(config);

  const handleClick = () => {
    console.log("🔘 Button clicked, token:", token, "ready:", ready);
    open();
  };

  return (
    <>
      {variant === "primary" ? (
        <Button
          onClick={handleClick}
          // disabled={!ready} // disable this temporarily to test
          className="plaidlink-primary"
        >
          Connect bank
        </Button>
      ) : variant === "ghost" ? (
        <Button onClick={handleClick} variant="ghost" className="plaidlink-ghost">
          <Image
            src="/icons/connect-bank.svg"
            alt="connect bank"
            width={24}
            height={24}
          />
          <p className="hiddenl text-[16px] font-semibold text-black-2 xl:block">
            Connect bank
          </p>
        </Button>
      ) : (
        <Button onClick={handleClick} className="plaidlink-default">
          <Image
            src="/icons/connect-bank.svg"
            alt="connect bank"
            width={24}
            height={24}
          />
          <p className="text-[16px] font-semibold text-black-2">Connect bank</p>
        </Button>
      )}
    </>
  );
};

export default PlaidLink;
