package com.academicagent.platform.identity.repository;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.identity.entity.UserCredential;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserCredentialRepository extends JpaRepository<UserCredential, String> {

    List<UserCredential> findByUserId(String userId);

    Optional<UserCredential> findByUserIdAndProfile(String userId, String profile);
}
